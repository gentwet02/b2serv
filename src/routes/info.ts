import { Hono } from 'hono';
import { extractSeasonId } from '@/utils/helpers';
import { getLiveSeason } from '..';

export const info = new Hono();

info.get('/', (c) => {
    const season = getLiveSeason();
    return c.json({
        message: season ? 'running' : 'waiting for api response...',
        error: season ? '200' : '425',
        liveSeason: extractSeasonId(season.name),
        totalScores: season.totalScores,
    });
});
