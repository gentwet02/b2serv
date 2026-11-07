import {
    SCHEDULE_DROP_AFTER_MS,
    SCHEDULE_EXPIRY_MARGIN_MS,
    SCHEDULE_RETRY_MS,
} from '@/config/crawler';
import type { NkUserId, ReadOutcome, ReadTiming } from '@/types/ninjakiwi';

/**
 * When each player's page (matches, profile) is read next, and the etag of their last read.
 *
 * Cloudflare keeps a copy of each page for a while (`cacheMs`), each on its own timer (`age`
 * says how far into it a copy is). Reading before it expires returns the same copy, so a
 * player is due just after their copy expires; reading any later still gets a fresh one.
 * There is no budget here: due players go to the limiter's "low" lane, which gets whatever
 * visitors and the leaderboard leave. When that's not enough, reads simply come late (the
 * stats' maxLateMin) and each player's cycle becomes cacheMs plus that wait.
 *
 * Players come from a roster: new ones are read at once, the ones off it for
 * SCHEDULE_DROP_AFTER_MS leave. A new season empties the schedule, so every player gets one
 * full read (no etag) as it starts. Kept in memory only: after a restart everyone is read
 * once, at the limiter's pace, then settles on their own timing.
 */

export interface ReadSchedule {
    readonly name: string;
    readonly cacheMs: number;
    size: () => number;
    syncRoster: (seasonId: number, roster: Iterable<NkUserId>, now: number) => void;
    duePlayers: (now: number) => NkUserId[];
    etagOf: (userId: NkUserId) => string | null;
    forgetEtag: (userId: NkUserId) => void;
    recordRead: (userId: NkUserId, outcome: ReadOutcome, now: number) => void;
    makeAllDue: () => void;
    nextReadInMs: (now: number) => number | null;
    stats: (now: number) => Record<string, number>;
}

export function createReadSchedule(name: string, cacheMs: number): ReadSchedule {
    const timings = new Map<NkUserId, ReadTiming>();
    let season: number | null = null;

    function syncRoster(seasonId: number, roster: Iterable<NkUserId>, now: number) {
        if (season !== seasonId) {
            timings.clear();
            season = seasonId;
        }
        for (const id of roster) {
            const timing = timings.get(id);
            if (timing) timing.seenAt = now;
            else timings.set(id, { etag: null, nextFetchAt: 0, lastFetchAt: 0, seenAt: now });
        }
        // a roster read that missed pages must not drop their players: only after a while
        for (const [id, timing] of timings) {
            if (now - timing.seenAt > SCHEDULE_DROP_AFTER_MS) timings.delete(id);
        }
    }

    function duePlayers(now: number) {
        return [...timings]
            .filter(([, t]) => t.nextFetchAt <= now)
            .sort(([, a], [, b]) => a.nextFetchAt - b.nextFetchAt)
            .map(([id]) => id);
    }

    /** When the copy we just got expires (no `age`: a fresh copy), plus a margin. */
    function nextReadAt(fetchedAt: number, ageS: number | null) {
        const ageMs = Math.min(cacheMs, Math.max(0, (ageS ?? 0) * 1000));
        return fetchedAt + cacheMs - ageMs + SCHEDULE_EXPIRY_MARGIN_MS;
    }

    function recordRead(userId: NkUserId, outcome: ReadOutcome, now: number) {
        const timing = timings.get(userId);
        if (!timing) return;
        if (!outcome.ok) {
            timing.nextFetchAt = now + SCHEDULE_RETRY_MS;
            return;
        }
        timing.lastFetchAt = now;
        timing.etag = outcome.etag ?? timing.etag;
        timing.nextFetchAt = nextReadAt(now, outcome.ageS);
    }

    function nextReadInMs(now: number) {
        let next = Infinity;
        for (const timing of timings.values()) next = Math.min(next, timing.nextFetchAt);
        return next === Infinity ? null : Math.max(0, next - now);
    }

    const schedule: ReadSchedule = {
        name,
        cacheMs,
        size: () => timings.size,
        syncRoster,
        duePlayers,
        etagOf: (userId) => timings.get(userId)?.etag ?? null,
        // read in full next time, whatever the etag says (matches that could not be filed)
        forgetEtag: (userId) => {
            const timing = timings.get(userId);
            if (timing) timing.etag = null;
        },
        recordRead,
        // admin force-update: etags are kept, unchanged pages stay cheap
        makeAllDue: () => {
            for (const timing of timings.values()) timing.nextFetchAt = 0;
        },
        nextReadInMs,
        stats: (now) => {
            const due = [...timings.values()].filter((t) => t.nextFetchAt <= now);
            // never-read players (nextFetchAt 0) would make this meaningless after a restart
            const late = due.filter((t) => t.nextFetchAt > 0).map((t) => now - t.nextFetchAt);
            return {
                players: timings.size,
                due: due.length,
                neverRead: due.length - late.length,
                maxLateMin: Math.round(Math.max(0, ...late) / 6_000) / 10,
                withEtag: [...timings.values()].filter((t) => t.etag).length,
            };
        },
    };
    return schedule;
}
