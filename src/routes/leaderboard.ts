import { Hono } from 'hono';
import { getLiveSeason, getSeasons } from '..';
import { env } from '@/config/environment';
import { fetchLeaderboard, fetchLiveSeason, fetchSeasons } from '@/services/ninjakiwi';
import { CachedLeaderboards } from '@/types/leaderboard';
import { Season } from '@/types/season';
import { encodePlayer } from '@/utils/encode';
import { delay, extractSeasonId } from '@/utils/helpers';
import { logger } from '@/utils/logger';

export const leaderboard = new Hono();

let cachedLeaderboards: CachedLeaderboards = {};
let liveSeason: Season | null = null;
let seasons: Season[] | null = null;

async function setCachedLeaderboard(season: Season | null) {
    if (!season) return;

    const seasonId = extractSeasonId(season.name);
    logger.debug(`Updating leaderboard cache of season ${seasonId}`);
    try {
        const result = await fetchLeaderboard(seasonId);
        cachedLeaderboards[seasonId] = result.map((player) => encodePlayer(player));
    } catch (error) {
        logger.error(`Failed to update cache: ${error}`);
    }
}

leaderboard.get('/:id?', async (c) => {
    liveSeason = getLiveSeason();
    seasons = getSeasons();
    const param = c.req.param('id');
    const { message, id } = validateParam(param);
    return c.json(
        id
            ? {
                  data: cachedLeaderboards[id],
                  message: cachedLeaderboards
                      ? `Data succesfuly loaded for season ${id + 1}`
                      : 'No data available yet, data is being fetched in the background, please try again in a few minutes.',
              }
            : {
                  error: {
                      message: message,
                  },
              }
    );
});

function validateParam(param: string | undefined): { message: string; id: number | null } {
    if (!param) {
        return {
            message: 'No season id passed with the request, redirecting to live season',
            id: extractSeasonId(liveSeason!.name),
        };
    }
    if (Number.isNaN(+param!) || +param < 0) {
        return { message: 'The season id needs to be a positive number', id: null };
    }
    if (+param > seasons!.length - 1) {
        return { message: 'The season id passed was not in the current season range', id: null };
    }
    return { message: '', id: +param };
}

async function onServerStart() {
    logger.debug('Performing initial leaderboards fetch...');
    seasons ?? (seasons = await fetchSeasons());
    for (let i = 0; i < seasons.length; i++) {
        delay(100);
        await setCachedLeaderboard(seasons[i]);
    }
    //seasons.map(async (season) => await setCachedLeaderboard(season));
    liveSeason ?? (liveSeason = await fetchLiveSeason(seasons));
    setInterval(() => setCachedLeaderboard(liveSeason), env.NK_FETCH_INTERVAL);
    logger.debug(
        `Scheduled live season leaderboard updates every ${env.NK_FETCH_INTERVAL / 1000} seconds`
    );
}

onServerStart().catch(console.error);
