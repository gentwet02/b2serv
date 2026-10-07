import { Hono, type Context } from 'hono';
import { getRankHistory } from '@/services/leaderboard';
import { getSeasonStats } from '@/services/matchStore';
import { getPlayerData } from '@/services/playerData';
import { getLiveSeason, getSeasonById } from '@/services/seasons';
import { logger } from '@/utils/logger';

/**
 * Player data for the client. The browser never calls Ninja Kiwi itself.
 *
 * GET /users/:id           NK profile (memory → MongoDB → NK, see services/playerData.ts)
 * GET /users/:id/matches   NK recent matches (fallback when we stored none)
 * GET /users/:id/season    season record from the stored matches
 * GET /users/:id/ranks     rank in every stored season, best end-of-season finish
 */
export const users = new Hono();

const USER_ID = /^[a-z0-9]{8,64}$/i;

const invalid = (c: Context) => {
    const message = 'Invalid user id';
    return c.json({ message, error: message }, 400);
};

function proxy(kind: 'profile' | 'matches') {
    return async (c: Context) => {
        const id = c.req.param('id') ?? '';
        if (!USER_ID.test(id)) return invalid(c);

        const entry = await getPlayerData(kind, id);
        if (!entry) {
            const message = "Ninja Kiwi's API didn't answer. Try again in a moment.";
            return c.json({ message, error: 'upstream_unavailable' }, 502);
        }
        if (!entry.data.success) {
            const message = entry.data.error || 'Player not found';
            return c.json({ message, error: message }, 404);
        }

        return c.json({ ...entry.data, fetchedAt: new Date(entry.fetchedAt).toISOString() });
    };
}

users.get('/:id/season', async (c) => {
    const id = c.req.param('id');
    if (!USER_ID.test(id)) return invalid(c);
    const seasonParam = c.req.query('season');
    const season = seasonParam ? getSeasonById(Number(seasonParam)) : getLiveSeason();
    if (!season) {
        const message = 'Unknown season';
        return c.json({ message, error: message }, 404);
    }
    try {
        return c.json({ ...(await getSeasonStats(id, season.seasonId)), seasonName: season.name });
    } catch (error) {
        logger.error(`Season stats of ${id} failed: ${error}`);
        const message = 'Could not compute the season record.';
        return c.json({ message, error: message }, 500);
    }
});

users.get('/:id/ranks', (c) => {
    const id = c.req.param('id');
    if (!USER_ID.test(id)) return invalid(c);
    return c.json(getRankHistory(id));
});

users.get('/:id/matches', proxy('matches'));
users.get('/:id', proxy('profile'));
