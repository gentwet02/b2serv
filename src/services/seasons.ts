import { env } from '@/config/environment';
import { fetchSeasons } from '@/services/ninjakiwi';
import type { Season } from '@/types/season';
import { logger } from '@/utils/logger';
import { scheduleEvery } from '@/utils/scheduler';

/** A season from the NK API, plus the id used in NK URLs and in our collection names. */
export interface SeasonInfo extends Season {
    seasonId: number;
}

const state = {
    seasons: [] as SeasonInfo[],
    live: null as SeasonInfo | null,
    lastFetch: null as Date | null,
};

/**
 * The id NK uses in its URLs (.../homs/season_45/leaderboard).
 * Read from the leaderboard URL first, the name is only a fallback.
 */
function toSeasonId(season: Season): number | null {
    const fromUrl = String(season.leaderboard ?? '').match(/season_(\d+)/);
    if (fromUrl) return Number(fromUrl[1]);

    const fromName = String(season.name ?? '').match(/\d+/);
    return fromName ? Number(fromName[0]) - 1 : null;
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

    state.seasons = seasons.sort((a, b) => b.seasonId - a.seasonId);
    state.live = state.seasons.find((s) => s.live) ?? state.seasons[0] ?? null;
    state.lastFetch = new Date();

    logger.debug(
        `Seasons: [${state.seasons.map((s) => s.seasonId).join(', ')}] live: ${state.live?.seasonId ?? 'none'}`,
    );
}

export const getSeasons = () => state.seasons;
export const getLiveSeason = () => state.live;
export const getSeasonById = (id: number) => state.seasons.find((s) => s.seasonId === id) ?? null;
export const getSeasonsLastFetch = () => state.lastFetch;

export async function startSeasonsScheduler() {
    await refreshSeasons();
    scheduleEvery('seasons', refreshSeasons, env.NK_FETCH_INTERVAL);
}
