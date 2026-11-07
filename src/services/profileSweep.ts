import { NK_PROFILES_CACHE_MS } from '@/config/cache';
import {
    PROFILE_SWEEP_BATCH,
    PROFILE_SWEEP_CONCURRENCY,
    PROFILE_SWEEP_PREVIOUS_SEASON_MS,
    SCHEDULE_TICK_MS,
} from '@/config/crawler';
import { NK_API } from '@/config/nk';
import { clanIdOf, refreshClans } from '@/services/clanStore';
import { ensureLeaderboard, getLeaderboardPlayers } from '@/services/leaderboard';
import { storeReadings, type ProfileReading } from '@/services/profileStore';
import { createReadSchedule } from '@/services/readSchedule';
import { getLiveSeason, getSeasons, seasonAt, toMs } from '@/services/seasons';
import type { NkUserId } from '@/types/ninjakiwi';
import type { NkProfileBody } from '@/types/profile';
import { learnAssetUrl } from '@/utils/assets';
import { extractUserId, fetchNk } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import { scheduleEvery } from '@/utils/scheduler';

/**
 * Reads the profile of every player of the live leaderboard, in the limiter's "low" lane.
 * Each player has their own timing (services/readSchedule.ts): read just after Cloudflare's
 * copy of their profile expires, about every NK_PROFILES_CACHE_MS, so HoM status and win
 * streak stay fresh.
 * A run reads the players due, every SCHEDULE_TICK_MS. A profile with the same etag as the
 * last read is not stored again. A new season empties the schedule: everyone is read in full
 * as it starts, which gives every player the reading their new season record starts from.
 *
 * Each reading is filed under the season live at that moment (seasons.seasonAt), so a
 * player's last reading of a season is at most one interval before its end, and readings
 * taken after the end but before the next season starts still close it.
 * For a few days after a season starts, its predecessor's players are read too: the new
 * leaderboard only lists who played already, and the others need the reading that starts
 * their new season.
 */

export const sweepState = {
    running: false,
    seasonId: null as number | null,
    done: 0,
    total: 0,
    stored: 0,
    failed: 0,
    /** profiles unchanged since their last read (not stored again) */
    unchanged: 0,
    lastRunStartedAt: null as Date | null,
    lastRunEndedAt: null as Date | null,
    lastError: null as string | null,
};

export const profileSchedule = createReadSchedule('profiles', NK_PROFILES_CACHE_MS);

interface NkProfileAnswer {
    success?: boolean;
    error?: string | null;
    body?: NkProfileBody;
}

async function playersToRead(): Promise<NkUserId[]> {
    const live = getLiveSeason();
    if (!live) return [];
    const ids = new Set(
        (await getLeaderboardPlayers(live)).map((p) => extractUserId(p.profile)).filter(Boolean),
    );

    const started = toMs(live.start);
    if (started > 0 && Date.now() - started < PROFILE_SWEEP_PREVIOUS_SEASON_MS) {
        const previous = getSeasons()
            .filter((s) => s.seasonId < live.seasonId)
            .sort((a, b) => b.seasonId - a.seasonId)[0];
        const entry = previous ? await ensureLeaderboard(previous) : null;
        for (const p of entry?.players ?? []) {
            const id = extractUserId(p.profile);
            if (id) ids.add(id);
        }
    }
    return [...ids];
}

export async function sweepProfiles(): Promise<void> {
    if (sweepState.running) return;
    const live = getLiveSeason();
    if (!live) return;

    // held while the roster is read, so two ticks don't run at once
    sweepState.running = true;
    let ids: NkUserId[];
    try {
        const roster = await playersToRead();
        if (roster.length === 0) throw new Error('No players to read (live leaderboard missing)');
        const now = Date.now();
        profileSchedule.syncRoster(live.seasonId, roster, now);
        ids = profileSchedule.duePlayers(now);
    } catch (error) {
        sweepState.lastError = String(error);
        sweepState.running = false;
        logger.error(`Profile sweep failed: ${error}`);
        return;
    }
    if (ids.length === 0) {
        sweepState.running = false;
        return;
    }

    Object.assign(sweepState, {
        running: true,
        seasonId: live.seasonId,
        done: 0,
        total: ids.length,
        stored: 0,
        failed: 0,
        unchanged: 0,
        lastError: null,
        lastRunStartedAt: new Date(),
    });

    let pending: ProfileReading[] = [];
    let writing: Promise<void> = Promise.resolve();
    function flush() {
        if (pending.length === 0) return;
        const batch = pending;
        pending = [];
        writing = writing.then(async () => {
            try {
                const saved = await storeReadings(batch);
                sweepState.stored += saved.readings;
            } catch (error) {
                sweepState.failed += batch.length;
                logger.error(`Storing ${batch.length} profile(s) failed: ${error}`);
                // their profiles may not change again: read them in full next time
                for (const reading of batch) {
                    profileSchedule.forgetEtag(reading.userId as NkUserId);
                }
            }
            // the clans of this batch: each read at most once a day, so this is cheap
            try {
                await refreshClans(
                    batch.flatMap((r) => {
                        const id = r.body.inGuild ? clanIdOf(r.body.guild) : null;
                        return id ? [id] : [];
                    }),
                );
            } catch (error) {
                logger.error(`Clan refresh failed: ${error}`);
            }
        });
    }

    try {
        let index = 0;
        async function worker() {
            while (index < ids.length) {
                const userId = ids[index++]!;
                const answer = await fetchNk<NkProfileAnswer>(NK_API.PLAYER_PROFILE(userId), {
                    priority: 'low',
                    retries: 3,
                    etag: profileSchedule.etagOf(userId),
                });
                sweepState.done++;
                const { etag, ageS } = answer;
                if (answer.status === 'unchanged') {
                    sweepState.unchanged++;
                    profileSchedule.recordRead(userId, { ok: true, etag, ageS }, Date.now());
                    continue;
                }
                const data = answer.data;
                if (!data?.success || !data.body) {
                    sweepState.failed++;
                    profileSchedule.recordRead(userId, { ok: false, etag, ageS }, Date.now());
                    continue;
                }
                const date = new Date();
                profileSchedule.recordRead(userId, { ok: true, etag, ageS }, date.getTime());
                const body = data.body;
                for (const url of [
                    body.equippedAvatarURL,
                    body.equippedBannerURL,
                    body.equippedBorderURL,
                ]) {
                    learnAssetUrl(url);
                }
                pending.push({
                    userId,
                    body,
                    date,
                    seasonId: seasonAt(getSeasons(), date.getTime()),
                });
                if (pending.length >= PROFILE_SWEEP_BATCH) flush();
            }
        }
        await Promise.all(Array.from({ length: PROFILE_SWEEP_CONCURRENCY }, worker));
        flush();
        await writing;
        // a run every few seconds: only failures are worth an info line
        logger[sweepState.failed > 0 ? 'info' : 'debug'](
            `Profile sweep: ${sweepState.stored}/${sweepState.total} stored, ` +
                `${sweepState.unchanged} unchanged, ${sweepState.failed} failed`,
        );
    } catch (error) {
        sweepState.lastError = String(error);
        logger.error(`Profile sweep failed: ${error}`);
    } finally {
        flush();
        await writing;
        sweepState.running = false;
        sweepState.lastRunEndedAt = new Date();
    }
}

/** ms until a player is due, null while a run reads; 0 before the schedule knows anyone */
export function nextSweepInMs(): number | null {
    if (sweepState.running) return null;
    return profileSchedule.nextReadInMs(Date.now()) ?? 0;
}

export function startProfileSweep() {
    void sweepProfiles();
    scheduleEvery(
        'profile-sweep',
        async () => {
            if (nextSweepInMs() === 0) await sweepProfiles();
        },
        SCHEDULE_TICK_MS,
    );
}
