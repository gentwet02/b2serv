import { Hono } from 'hono';
import type { CachedMatches } from '@/types/match';
import { env } from '@/config/environment';
import { updateMatchesHistoryCache } from '@/services/matchesHistory';

export const matchesHistory = new Hono();

let cachedMatches: CachedMatches | null = null;
let isCurrentlyFetching = false;

async function setCachedMatches() {
    [isCurrentlyFetching, cachedMatches] = await updateMatchesHistoryCache(
        isCurrentlyFetching,
        cachedMatches
    );
}

matchesHistory.get('/', async (c) => {
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
    await setCachedMatches();
    return c.json({ message: 'Force update triggered. Check /status for progress.' });
});

async function onServerStart() {
    console.log('Server starting...');

    console.log('Performing initial data fetch...');
    await setCachedMatches();
    setInterval(setCachedMatches, env.NK_FETCH_INTERVAL);
    console.log(`Scheduled updates every ${env.NK_FETCH_INTERVAL / 1000} seconds`);

    console.log('Server ready!');
}

onServerStart().catch(console.error);
