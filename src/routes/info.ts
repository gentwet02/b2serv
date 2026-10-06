import { Hono } from 'hono';
import { getLiveSeason, getSeasons, getSeasonsLastFetch } from '@/services/seasons';

export const info = new Hono();

info.get('/', (c) => {
    const season = getLiveSeason();

    if (!season) {
        return c.json({ message: 'waiting for api response...', error: '425' });
    }

    return c.json({
        message: 'running',
        error: '200',
        liveSeason: season.seasonId,
        liveSeasonName: season.name,
        totalScores: season.totalScores,
        seasons: getSeasons().map((s) => ({ id: s.seasonId, name: s.name, live: s.live })),
        lastFetch: getSeasonsLastFetch()?.toISOString() ?? null,
    });
});
