import { getMatchesByUserId } from '@/services/database';
import { Hono } from 'hono';
import { getLiveSeason } from '..';
import { extractSeasonId } from '@/utils/helpers';

export const matches = new Hono();

matches.get('/:id', async (c) => {
    const seasonId = extractSeasonId(getLiveSeason().name);
    const userId = c.req.param('id');
    const matches = await getMatchesByUserId(userId, seasonId);
    return c.json(matches);
});
