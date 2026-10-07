import { env } from '@/config/environment';
import { fetchLeaderboard } from '@/services/ninjakiwi';
import { getLiveSeason, getSeasons, type SeasonInfo } from '@/services/seasons';
import {
    listFinalSeasonIds,
    loadAllStoredLeaderboards,
    loadStoredLeaderboard,
    storeLeaderboard,
} from '@/services/leaderboardStore';
import { warmProfiles } from '@/services/playerData';
import type { LeaderboardPlayer, LeaderboardPlayerEncoded } from '@/types/leaderboard';
import { encodePlayer } from '@/utils/encode';
import { extractUserId, type Priority } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import { scheduleEvery } from '@/utils/scheduler';

interface LeaderboardEntry {
    players: LeaderboardPlayer[];
    encoded: LeaderboardPlayerEncoded[];
    updatedAt: Date;
    final: boolean;
}

const cache = new Map<number, LeaderboardEntry>();
const inFlight = new Map<number, Promise<void>>();

/** seasonId → userId → rank (1-based) and score; every season we have, for rank history. */
const seasonRanks = new Map<number, Map<string, { rank: number; score: number }>>();

function remember(seasonId: number, players: LeaderboardPlayer[], updatedAt: Date, final: boolean) {
    cache.set(seasonId, {
        players,
        encoded: players.map((player) => encodePlayer(player)),
        updatedAt,
        final,
    });
    indexRanks(seasonId, players);
}

function indexRanks(seasonId: number, players: LeaderboardPlayer[]) {
    seasonRanks.set(
        seasonId,
        new Map(players.map((p, i) => [extractUserId(p.profile), { rank: i + 1, score: p.score }])),
    );
}

/** A player's rank in every season we have, newest season first. */
export function getRankHistory(userId: string) {
    const live = getLiveSeason();
    const seasons = getSeasons();
    const history: {
        seasonId: number;
        name: string;
        rank: number;
        score: number;
        final: boolean;
    }[] = [];
    for (const [seasonId, ranks] of seasonRanks) {
        const entry = ranks.get(userId);
        if (!entry) continue;
        const season = seasons.find((s) => s.seasonId === seasonId);
        history.push({
            seasonId,
            name: season?.name ?? `Season ${seasonId + 1}`,
            ...entry,
            final: seasonId !== live?.seasonId,
        });
    }
    history.sort((a, b) => b.seasonId - a.seasonId);
    const finished = history.filter((h) => h.final);
    const best = finished.reduce<(typeof history)[number] | null>(
        (top, h) => (!top || h.rank < top.rank ? h : top),
        null,
    );
    return { current: history.find((h) => !h.final) ?? null, best, seasons: history };
}

/** Fetches a season from Ninja Kiwi, keeps it in memory and stores it in Mongo. */
export function updateLeaderboard(season: SeasonInfo, priority: Priority = 'low'): Promise<void> {
    const id = season.seasonId;
    const running = inFlight.get(id);
    if (running) return running;

    const job = (async () => {
        logger.debug(`Updating leaderboard of season ${id} (${priority})`);
        const players = await fetchLeaderboard(id, priority);
        if (players.length === 0) {
            logger.error(`Season ${id}: empty leaderboard, keeping the previous cache`);
            return;
        }
        const updatedAt = new Date();
        const final = !season.live;
        remember(id, players, updatedAt, final);
        // the top of the live leaderboard gets viewed most: keep those profiles (and avatars) fresh
        if (season.live) warmProfiles(players.slice(0, 10).map((p) => extractUserId(p.profile)));
        await storeLeaderboard({ seasonId: id, players, updatedAt, final });
        logger.debug(`Season ${id}: ${players.length} players cached${final ? ' (final)' : ''}`);
    })()
        .catch((error) => logger.error(`Leaderboard update of season ${id} failed: ${error}`))
        .finally(() => inFlight.delete(id));

    inFlight.set(id, job);
    return job;
}

export const getCachedLeaderboard = (seasonId: number) => cache.get(seasonId) ?? null;

/**
 * What a visitor's request goes through: memory, then Mongo, then Ninja Kiwi at high priority.
 * A finished season is fetched from NK once in the server's whole life.
 */
export async function ensureLeaderboard(season: SeasonInfo): Promise<LeaderboardEntry | null> {
    const id = season.seasonId;
    const inMemory = cache.get(id);
    if (inMemory && (inMemory.final || season.live)) return inMemory;

    if (!inMemory) {
        const stored = await loadStoredLeaderboard(id);
        if (stored && stored.players.length > 0) {
            remember(id, stored.players, new Date(stored.updatedAt), stored.final);
            // a stored live snapshot is served right away; the scheduler refreshes it
            if (stored.final || season.live) return cache.get(id)!;
        }
    }

    // missing, or stored while the season was still live and it has ended since
    await updateLeaderboard(season, 'high');
    return cache.get(id) ?? null;
}

export async function getLeaderboardPlayers(season: SeasonInfo, maxAgeMs = env.NK_FETCH_INTERVAL) {
    const entry = cache.get(season.seasonId) ?? (await ensureLeaderboard(season));
    if (!entry || (!entry.final && Date.now() - entry.updatedAt.getTime() > maxAgeMs)) {
        await updateLeaderboard(season);
    }
    return cache.get(season.seasonId)?.players ?? [];
}

/**
 * Background, low priority: fetch every finished season not stored yet,
 * one at a time, newest first. Runs once; afterwards old seasons are instant.
 */
async function warmPastSeasons() {
    const stored = await listFinalSeasonIds();
    const missing = getSeasons().filter((s) => !s.live && !stored.has(s.seasonId));
    if (missing.length === 0) return;

    logger.debug(
        `Warming ${missing.length} past season(s): ${missing.map((s) => s.seasonId).join(', ')}`,
    );
    for (const season of missing) {
        if (cache.get(season.seasonId)?.final) continue;
        await updateLeaderboard(season, 'low');
    }
    logger.debug('Past seasons warmed');
}

/** Rank history needs every stored season; only their ranks are kept in memory. */
async function indexStoredSeasons() {
    const stored = await loadAllStoredLeaderboards();
    for (const entry of stored) {
        if (!seasonRanks.has(entry.seasonId)) indexRanks(entry.seasonId, entry.players);
    }
    logger.debug(`Rank history: ${stored.length} stored season(s) indexed`);
}

export async function startLeaderboardScheduler() {
    await indexStoredSeasons();
    const live = getLiveSeason();
    if (live) {
        // serve the last stored snapshot at once, then refresh it
        await ensureLeaderboard(live);
        void updateLeaderboard(live);
    } else {
        logger.error('Leaderboard: no live season at startup, waiting for the next run');
    }

    scheduleEvery(
        'leaderboard-live',
        async () => {
            const season = getLiveSeason();
            if (season) await updateLeaderboard(season);
        },
        env.NK_FETCH_INTERVAL,
    );

    void warmPastSeasons().catch((error) => logger.error(`Warming past seasons failed: ${error}`));
}
