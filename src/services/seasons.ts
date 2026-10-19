import mongoose from 'mongoose';
import { env } from '@/config/environment';
import { listStoredSeasonIds } from '@/services/leaderboardStore';
import { fetchSeasons } from '@/services/ninjakiwi';
import type { Season } from '@/types/season';
import { logger } from '@/utils/logger';
import { scheduleEvery } from '@/utils/scheduler';

export interface SeasonInfo extends Season {
    seasonId: number;
    /** not listed by NK anymore, known only from our own data */
    archived?: boolean;
}

const state = {
    seasons: [] as SeasonInfo[],
    live: null as SeasonInfo | null,
    lastFetch: null as Date | null,
};

export function toSeasonId(season: Season): number | null {
    const fromUrl = String(season.leaderboard ?? '').match(/season_(\d+)/);
    if (fromUrl) return Number(fromUrl[1]);

    const fromName = String(season.name ?? '').match(/\d+/);
    return fromName ? Number(fromName[0]) - 1 : null;
}

/** Seasons we have data for (matches or a leaderboard). Computed once: they don't change. */
let storedIds: Promise<Set<number>> | null = null;
const archivedCache = new Map<number, SeasonInfo>();

function loadStoredIds(): Promise<Set<number>> {
    storedIds ??= (async () => {
        const db = mongoose.connection.db;
        if (!db) throw new Error('database not connected');
        const ids = new Set<number>(await listStoredSeasonIds());
        for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
            const match = name.match(/^matches_s(\d+)$/);
            if (match) ids.add(Number(match[1]));
        }
        return ids;
    })().catch((error) => {
        storedIds = null;
        logger.error(`Listing stored seasons failed: ${error}`);
        return new Set<number>();
    });
    return storedIds;
}

async function archivedSeason(seasonId: number): Promise<SeasonInfo> {
    const cached = archivedCache.get(seasonId);
    if (cached) return cached;

    const matches = mongoose.connection.collection<{ t: number }>(`matches_s${seasonId}`);
    const [first, last] = await Promise.all([
        matches
            .find({}, { projection: { t: 1 } })
            .sort({ t: 1 })
            .limit(1)
            .next(),
        matches
            .find({}, { projection: { t: 1 } })
            .sort({ t: -1 })
            .limit(1)
            .next(),
    ]);
    const info: SeasonInfo = {
        id: `archived-${seasonId}`,
        name: `Season ${seasonId + 1}`,
        start: first ? first.t * 60_000 : 0,
        end: last ? last.t * 60_000 : 0,
        live: false,
        totalScores: 0,
        leaderboard: '' as Season['leaderboard'],
        seasonId,
        archived: true,
    };
    archivedCache.set(seasonId, info);
    return info;
}

export async function refreshSeasons() {
    const raw = await fetchSeasons();

    if (raw.length === 0) {
        logger.error('Seasons fetch returned nothing, keeping the previous list');
        return;
    }

    const seasons: SeasonInfo[] = [];
    for (const season of raw) {
        const seasonId = toSeasonId(season);
        if (seasonId === null) {
            logger.error(
                `Unreadable season id: ${JSON.stringify({ name: season.name, lb: season.leaderboard })}`,
            );
            continue;
        }
        seasons.push({ ...season, seasonId });
    }

    const listed = new Set(seasons.map((s) => s.seasonId));
    const missing = [...(await loadStoredIds())].filter((id) => !listed.has(id));
    try {
        seasons.push(...(await Promise.all(missing.map(archivedSeason))));
    } catch (error) {
        logger.error(`Building archived seasons failed: ${error}`);
    }

    state.seasons = seasons.sort((a, b) => b.seasonId - a.seasonId);
    state.live =
        state.seasons.find((s) => s.live) ?? state.seasons.find((s) => !s.archived) ?? null;
    state.lastFetch = new Date();

    logger.debug(
        `Seasons: [${state.seasons.map((s) => `${s.seasonId}${s.archived ? 'a' : ''}`).join(', ')}] live: ${state.live?.seasonId ?? 'none'}`,
    );
}

/** NK gives season times in seconds or milliseconds */
export const toMs = (v: number) => (v < 1e12 ? v * 1000 : v);

/**
 * The season a moment belongs to: the latest one started by then. Between the end of a season
 * and the start of the next, that's still the one that ended (no ranked game can count for the
 * next one yet), so a reading taken then closes it.
 */
export function seasonAt(seasons: { seasonId: number; start: number }[], dateMs: number) {
    let found: number | null = null;
    let foundStart = -Infinity;
    for (const s of seasons) {
        const start = toMs(s.start);
        if (start > 0 && start <= dateMs && start > foundStart) {
            found = s.seasonId;
            foundStart = start;
        }
    }
    return found;
}

export const getSeasons = () => state.seasons;
export const getLiveSeason = () => state.live;
export const getSeasonById = (id: number) => state.seasons.find((s) => s.seasonId === id) ?? null;
export const getSeasonsLastFetch = () => state.lastFetch;

export async function startSeasonsScheduler() {
    await refreshSeasons();
    scheduleEvery('seasons', refreshSeasons, env.NK_FETCH_INTERVAL);
}
