import { Hono } from 'hono';
import { ERROR_MESSAGES } from '@/config/errors';
import { getMatchesByUserId } from '@/services/database';
import { getLiveSeason, getSeasonById } from '@/services/seasons';
import { isNkUserId } from '@/utils/helpers';

export const matches = new Hono();

/**
 * GET /matches/:id
 * GET /matches/:id?season=46
 */
matches.get('/:id', async (c) => {
    const seasonParam = c.req.query('season');
    const season = seasonParam ? getSeasonById(Number(seasonParam)) : getLiveSeason();

    if (!season) {
        const message = seasonParam
            ? `Unknown season id: ${seasonParam}`
            : 'Live season not available yet';
        return c.json({ message, error: { message } }, seasonParam ? 404 : 503);
    }

    const userId = c.req.param('id');
    if (!isNkUserId(userId)) {
        const message = ERROR_MESSAGES.INVALID_USER_ID;
        return c.json({ message, error: { message } }, 400);
    }

    return c.json(await getMatchesByUserId(userId, season.seasonId));
});
