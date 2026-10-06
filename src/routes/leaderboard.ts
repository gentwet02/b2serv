import { Hono } from 'hono';
import { getCachedLeaderboard, updateLeaderboard } from '@/services/leaderboard';
import { getLiveSeason, getSeasonById, type SeasonInfo } from '@/services/seasons';

export const leaderboard = new Hono();

leaderboard.get('/:id?', async (c) => {
    const param = c.req.param('id');

    let season: SeasonInfo | null;
    if (param === undefined) {
        season = getLiveSeason();
        if (!season) {
            const message = 'Live season not available yet, please try again in a moment.';
            return c.json({ message, error: { message } }, 503);
        }
    } else {
        season = /^\d+$/.test(param) ? getSeasonById(Number(param)) : null;
        if (!season) {
            const message = `Unknown season id: ${param}`;
            return c.json({ message, error: { message } }, 404);
        }
    }

    if (!getCachedLeaderboard(season.seasonId)) await updateLeaderboard(season);

    const entry = getCachedLeaderboard(season.seasonId);
    if (!entry) {
        const message = 'No data available yet, please try again in a few minutes.';
        return c.json({ message, error: { message } }, 503);
    }

    return c.json({
        seasonId: season.seasonId,
        live: season.live,
        lastUpdated: entry.updatedAt.toISOString(),
        message: `Data successfully loaded for ${season.name}`,
        data: entry.encoded,
    });
});
