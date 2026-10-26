import { env } from '@/config/environment';
import { NK_API } from '@/config/constants';
import { clanIdOf, refreshClans } from '@/services/clanStore';
import { ensureLeaderboard, getLeaderboardPlayers } from '@/services/leaderboard';
import { lastReadTimes, storeReadings, type ProfileReading } from '@/services/profileStore';
import { getLiveSeason, getSeasons, seasonAt, toMs } from '@/services/seasons';
import type { NkProfileBody } from '@/types/profile';
import { learnAssetUrl } from '@/utils/assets';
import { extractUserId, fetchWithRetry } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import { scheduleEvery } from '@/utils/scheduler';

/**
 * Reads the profile of every player of the live leaderboard, at low priority, one pass every
 * NK_PROFILES_INTERVAL (spaced from the end of the previous pass), stalest players first.
 *
 * Each reading is filed under the season live at that moment (seasons.seasonAt), so a
 * player's last reading of a season is at most one interval before its end, and readings
 * taken after the end but before the next season starts still close it.
 * For a few days after a season starts, its predecessor's players are read too: the new
 * leaderboard only lists who played already, and the others need the reading that starts
 * their new season.
 */

const CONCURRENCY = 2;
const BATCH = 50;
/** after a season starts, keep reading the previous season's players this long */
const PREVIOUS_SEASON_MS = 3 * 24 * 3600_000;

export const sweepState = {
    running: false,
    seasonId: null as number | null,
    done: 0,
    total: 0,
    stored: 0,
    failed: 0,
    lastRunStartedAt: null as Date | null,
    lastRunEndedAt: null as Date | null,
    lastError: null as string | null,
};

interface NkProfileAnswer {
    success?: boolean;
    error?: string | null;
    body?: NkProfileBody;
}

async function playersToRead(): Promise<string[]> {
    const live = getLiveSeason();
    if (!live) return [];
    const ids = new Set(
        (await getLeaderboardPlayers(live)).map((p) => extractUserId(p.profile)).filter(Boolean),
    );

    const started = toMs(live.start);
    if (started > 0 && Date.now() - started < PREVIOUS_SEASON_MS) {
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
    Object.assign(sweepState, {
        running: true,
        seasonId: getLiveSeason()?.seasonId ?? null,
        done: 0,
        total: 0,
        stored: 0,
        failed: 0,
        lastError: null,
        lastRunStartedAt: new Date(),
    });

    let pending: ProfileReading[] = [];
    let writing: Promise<void> = Promise.resolve();
    const flush = () => {
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
    };

    try {
        const ids = await playersToRead();
        if (ids.length === 0) throw new Error('No players to read (live leaderboard missing)');
        const lastRead = await lastReadTimes(ids);
        ids.sort((a, b) => (lastRead.get(a) ?? 0) - (lastRead.get(b) ?? 0));
        sweepState.total = ids.length;

        let index = 0;
        const worker = async () => {
            while (index < ids.length) {
                const userId = ids[index++]!;
                const data = await fetchWithRetry<NkProfileAnswer>(NK_API.PLAYER_PROFILE(userId), {
                    priority: 'low',
                    retries: 3,
                });
                sweepState.done++;
                if (!data?.success || !data.body) {
                    sweepState.failed++;
                    continue;
                }
                const date = new Date();
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
                if (pending.length >= BATCH) flush();
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
        flush();
        await writing;
        logger.info(
            `Profile sweep: ${sweepState.stored}/${sweepState.total} stored, ${sweepState.failed} failed`,
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

/** ms until the next pass may start, null while one runs */
export function nextSweepInMs(): number | null {
    if (sweepState.running) return null;
    const ended = sweepState.lastRunEndedAt?.getTime();
    return ended ? Math.max(0, ended + env.NK_PROFILES_INTERVAL - Date.now()) : 0;
}

export function startProfileSweep() {
    void sweepProfiles();
    scheduleEvery(
        'profile-sweep',
        async () => {
            if (nextSweepInMs() === 0) await sweepProfiles();
        },
        60_000,
    );
}
