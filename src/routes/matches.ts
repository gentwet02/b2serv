import { Hono } from 'hono';
import { getMatchesByUserId } from '@/services/database';
import { getLiveSeason, getSeasonById } from '@/services/seasons';

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
    if (!/^[a-z0-9]+$/i.test(userId)) {
        const message = 'Invalid user id';
        return c.json({ message, error: { message } }, 400);
    }

    return c.json(await getMatchesByUserId(userId, season.seasonId));
});
