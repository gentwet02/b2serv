import { env } from '@/config/environment';
import {
    listFinalSeasonIds,
    loadAllStoredLeaderboards,
    loadStoredLeaderboard,
    storeLeaderboard,
} from '@/services/leaderboardStore';
import { fetchLeaderboard } from '@/services/ninjakiwi';
import { nameTimelineOf } from '@/services/codeBook';
import { getLiveSeason, getSeasons, type SeasonInfo } from '@/services/seasons';
import type { LeaderboardPlayer, LeaderboardPlayerEncoded } from '@/types/leaderboard';
import type { NkUserId } from '@/types/ninjakiwi';
import type { PastName } from '@/types/player';
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

/**
 * seasonId → userId → rank (1-based), score and the name they had then; every season we have,
 * for rank and name history.
 */
const seasonRanks = new Map<
    number,
    Map<NkUserId, { rank: number; score: number; name: string }>
>();

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
        new Map(
            players.map((p, i) => [
                extractUserId(p.profile),
                { rank: i + 1, score: p.score, name: p.displayName },
            ]),
        ),
    );
}

export const getLeaderboardSize = (seasonId: number) => seasonRanks.get(seasonId)?.size ?? null;

/** Players ranked `from`–`to` (inclusive) in a season, or null when that leaderboard isn't loaded. */
export function getRankRange(seasonId: number, from: number, to: number) {
    const ranks = seasonRanks.get(seasonId);
    if (!ranks) return null;
    const players: { userId: NkUserId; rank: number }[] = [];
    for (const [userId, { rank }] of ranks) {
        if (rank >= from && rank <= to) players.push({ userId, rank });
    }
    return players.sort((a, b) => a.rank - b.rank);
}

export const getSeasonRank = (seasonId: number, userId: NkUserId) =>
    seasonRanks.get(seasonId)?.get(userId)?.rank ?? null;

export function getRankHistory(userId: NkUserId) {
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
            rank: entry.rank,
            score: entry.score,
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

/**
 * Indexes of the longest run of `seasons` (undefined = undated, skipped) that never goes back
 * in time: the dated names that agree with the order they were recorded in.
 */
function inOrderIndexes(seasons: (number | undefined)[]): Set<number> {
    const dated = seasons.flatMap((s, i) => (s === undefined ? [] : [{ i, s }]));
    const length = dated.map(() => 1);
    const previous = dated.map(() => -1);
    for (let b = 0; b < dated.length; b++) {
        for (let a = 0; a < b; a++) {
            if (dated[a]!.s <= dated[b]!.s && length[a]! + 1 > length[b]!) {
                length[b] = length[a]! + 1;
                previous[b] = a;
            }
        }
    }
    const kept = new Set<number>();
    let at = length.indexOf(Math.max(0, ...length));
    while (at !== -1) {
        kept.add(dated[at]!.i);
        at = previous[at]!;
    }
    return kept;
}

/**
 * The player's old names, oldest first. `o` is in the order names were recorded, which is
 * right for the ones we watched live, but an import of old seasons appends its names at the
 * end (rename: false). So the dated names that agree with that order stay as they are, names
 * on no leaderboard keep their place among them, and the dated names that don't agree (or
 * aren't in the code book) are moved after the last dated name of an earlier or same season.
 */
function orderNames(recorded: string[], latestOf: (name: string) => number | undefined) {
    const kept = inOrderIndexes(recorded.map(latestOf));
    const order = recorded.filter((name, i) => latestOf(name) === undefined || kept.has(i));
    const moved = recorded.filter((name, i) => latestOf(name) !== undefined && !kept.has(i));
    for (const name of moved.sort((a, b) => latestOf(a)! - latestOf(b)!)) {
        const latest = latestOf(name)!;
        let after = -1;
        order.forEach((other, i) => {
            const season = latestOf(other);
            if (season !== undefined && season <= latest) after = i;
        });
        order.splice(after + 1, 0, name);
    }
    return order;
}

/**
 * The names a player went by other than `currentName`, newest first. Seasons come from the
 * leaderboards, the only data that keeps the name a player had at the time; the order is the
 * code book's, fixed by those seasons (orderNames). A name on no leaderboard gets the seasons
 * of the dated names around it as bounds.
 */
export function getNameHistory(userId: NkUserId, currentName: string): PastName[] {
    const seasonsOf = new Map<string, number[]>();
    for (const [seasonId, ranks] of seasonRanks) {
        const name = ranks.get(userId)?.name;
        if (name) seasonsOf.set(name, [...(seasonsOf.get(name) ?? []), seasonId]);
    }
    for (const seasons of seasonsOf.values()) seasons.sort((a, b) => b - a);

    const isOld = (name: string) => name !== currentName && name !== 'Unknown player';
    const recorded = nameTimelineOf(userId).filter(isOld);
    // a name ranked under but missing from the code book (shouldn't happen): placed by season
    for (const name of seasonsOf.keys()) {
        if (isOld(name) && !recorded.includes(name)) recorded.push(name);
    }
    const timeline = orderNames(recorded, (name) => seasonsOf.get(name)?.[0]);

    // the current name's first ranked season bounds the newest old names
    const currentFirst = seasonsOf.get(currentName)?.at(-1);
    return timeline
        .map((name, i): PastName => {
            const seasons = seasonsOf.get(name) ?? [];
            if (seasons.length > 0) return { name, seasons };
            const olderSeason = timeline
                .slice(0, i)
                .reverse()
                .map((n) => seasonsOf.get(n)?.[0])
                .find((s) => s !== undefined);
            const newerSeason =
                timeline
                    .slice(i + 1)
                    .map((n) => seasonsOf.get(n)?.at(-1))
                    .find((s) => s !== undefined) ?? currentFirst;
            return {
                name,
                seasons,
                ...(olderSeason !== undefined && { after: olderSeason }),
                ...(newerSeason !== undefined && { before: newerSeason }),
            };
        })
        .reverse();
}

/** Fetches a season from Ninja Kiwi, keeps it in memory and stores it in Mongo */
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
 * What a visitor's request goes through: memory, then MongoDB. Never Ninja Kiwi: a season we
 * don't have yet comes with the background jobs (live refresh, warmPastSeasons).
 * A season stored while live and ended since is served as stored until its final copy arrives.
 */
export async function readLeaderboard(season: SeasonInfo): Promise<LeaderboardEntry | null> {
    const inMemory = cache.get(season.seasonId);
    if (inMemory) return inMemory;
    const stored = await loadStoredLeaderboard(season.seasonId);
    if (!stored || stored.players.length === 0) return null;
    remember(season.seasonId, stored.players, new Date(stored.updatedAt), stored.final);
    return cache.get(season.seasonId)!;
}

/** Background jobs only: memory, then MongoDB, then Ninja Kiwi (low priority). */
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
    await updateLeaderboard(season, 'low');
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
 * Background, low priority: fetch every finished season not stored as final yet (new, or
 * stored while it was live). Runs with every live refresh, so an ended season gets its final
 * copy soon after NK closes it.
 */
let warming = false;
async function warmPastSeasons() {
    if (warming) return;
    warming = true;
    try {
        await warmMissingSeasons();
    } finally {
        warming = false;
    }
}

async function warmMissingSeasons() {
    const stored = await listFinalSeasonIds();
    const missing = getSeasons().filter((s) => !s.live && !s.archived && !stored.has(s.seasonId));
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

/** Rank history needs every stored season; only their ranks are kept in memory */
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
            await warmPastSeasons();
        },
        env.NK_FETCH_INTERVAL,
    );

    void warmPastSeasons().catch((error) => logger.error(`Warming past seasons failed: ${error}`));
}
