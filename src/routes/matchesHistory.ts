import { Hono } from 'hono';
import type { CachedMatches } from '@/types/match';
import { env } from '@/config/environment';
import { updateMatchesHistoryCache } from '@/services/matchesHistory';
import { createMatch, getMatchById } from '@/services/database';
import { logger } from '@/utils/logger';

export const matchesHistory = new Hono();

let cachedMatches: CachedMatches | null = null;
let isCurrentlyFetching = false;

async function setCachedMatches() {
    [isCurrentlyFetching, cachedMatches] = await updateMatchesHistoryCache(
        isCurrentlyFetching,
        cachedMatches
    );

    if (!cachedMatches) {
        return;
    }

    cachedMatches.matches.map(async (match) => {
        const isAlreadyRegistered = await getMatchById(match.id);

        if (isAlreadyRegistered) {
            logger.debug(`match ${match.id} was already in the database`);
            return;
        }

        if (!cachedMatches?.seasonID) {
            logger.error(`cachedMatches has no season id defined`);
            return;
        }

        createMatch({
            timeStamp: new Date(),
            seasonId: cachedMatches?.seasonID,
            ...match,
        });
    });
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
    logger.debug('Server starting...');

    logger.debug('Performing initial data fetch...');
    await setCachedMatches();
    setInterval(setCachedMatches, env.NK_FETCH_INTERVAL);
    logger.debug(`Scheduled updates every ${env.NK_FETCH_INTERVAL / 1000} seconds`);

    logger.debug('Server ready!');
}

onServerStart().catch(console.error);
