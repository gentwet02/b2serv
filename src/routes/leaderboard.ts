import { Hono } from 'hono';
import { ensureLeaderboard } from '@/services/leaderboard';
import { getSeasonRecords } from '@/services/matchStore';
import { getKnownAvatars } from '@/services/playerData';
import { extractUserId } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import { getLiveSeason, getSeasonById, type SeasonInfo } from '@/services/seasons';

export const leaderboard = new Hono();

/**
 * GET /leaderboard/:id/stats
 */
leaderboard.get('/:id/stats', async (c) => {
    const param = c.req.param('id');
    const season = /^\d+$/.test(param) ? getSeasonById(Number(param)) : null;
    if (!season) {
        const message = `Unknown season id: ${param}`;
        return c.json({ message, error: message }, 404);
    }
    try {
        const entry = await ensureLeaderboard(season);
        const top = (entry?.players ?? []).slice(0, 100).map((p) => extractUserId(p.profile));
        const [records, avatars] = await Promise.all([
            getSeasonRecords(season.seasonId),
            getKnownAvatars(top),
        ]);
        c.header('Cache-Control', 'public, max-age=60');
        return c.json({ seasonId: season.seasonId, records, avatars });
    } catch (error) {
        logger.error(`Leaderboard stats of season ${season.seasonId} failed: ${error}`);
        const message = 'Could not compute the leaderboard stats.';
        return c.json({ message, error: message }, 500);
    }
});

leaderboard.get('/:id?', async (c) => {
    const param = c.req.param('id');

    let season: SeasonInfo | null;
    if (param === undefined) {
        season = getLiveSeason();
        if (!season) {
            const message = 'Live season not available yet, please try again in a moment.';
            return c.json({ message, error: message }, 503);
        }
    } else {
        season = /^\d+$/.test(param) ? getSeasonById(Number(param)) : null;
        if (!season) {
            const message = `Unknown season id: ${param}`;
            return c.json({ message, error: message }, 404);
        }
    }

    const entry = await ensureLeaderboard(season);
    if (!entry) {
        const message = "Ninja Kiwi's API didn't send this leaderboard. Try again in a minute.";
        return c.json({ message, error: message }, 503);
    }

    // finished seasons never change: let the browser keep them for a day
    c.header('Cache-Control', entry.final ? 'public, max-age=86400' : 'public, max-age=30');

    return c.json({
        seasonId: season.seasonId,
        live: season.live,
        lastUpdated: entry.updatedAt.toISOString(),
        message: `Data successfully loaded for ${season.name}`,
        data: entry.encoded,
    });
});
