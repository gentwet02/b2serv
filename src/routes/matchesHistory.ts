import { env } from '@/config/environment';
import { getLiveSeason } from '@/index';
import { setCachedMatches } from '@/services/matchesHistory';
import type { CachedMatches } from '@/types/match';
import type { Season } from '@/types/season';
import { logger } from '@/utils/logger';
import { Hono } from 'hono';

export const matchesHistory = new Hono();

let cachedMatches: CachedMatches | null = null;
let isCurrentlyFetching = false;
let liveSeason: Season | null = null;

async function setCache() {
    const [isFetching, cache] = await setCachedMatches(
        liveSeason,
        isCurrentlyFetching,
        cachedMatches
    );
    isCurrentlyFetching = isFetching;
    cachedMatches = cache;
}

matchesHistory.get('/', async (c) => {
    liveSeason = getLiveSeason();
    return c.json({
        matches: cachedMatches,
        error: cachedMatches
            ? null
            : 'No data available yet. Data is being fetched in the background.',
        message: cachedMatches ? null : 'Please try again in a few minutes.',
    });
});

matchesHistory.get('/status', (c) => {
    return c.json({
        message: 'running',
        hasCache: !!cachedMatches,
        isFetching: isCurrentlyFetching,
        lastUpdated: cachedMatches?.lastUpdated?.toISOString() || null,
        nextUpdateIn: cachedMatches
            ? Math.max(
                  0,
                  env.NK_FETCH_INTERVAL - (Date.now() - cachedMatches?.lastUpdated?.getTime() || 0)
              )
            : 'unknown',
        timestamp: new Date().toISOString(),
    });
});

matchesHistory.get('/force-update', async (c) => {
    if (isCurrentlyFetching) {
        return c.json({ message: 'Update already in progress' });
    }
    await setCache();
    return c.json({ message: 'Force update triggered. Check /status for progress.' });
});

async function onServerStart() {
    logger.debug('Server starting...');

    logger.debug('Performing initial data fetch...');
    await setCache();
    setInterval(setCache, env.NK_FETCH_INTERVAL);
    logger.debug(`Scheduled updates every ${env.NK_FETCH_INTERVAL / 1000} seconds`);

    logger.debug('Server ready!');
}

onServerStart().catch(console.error);
