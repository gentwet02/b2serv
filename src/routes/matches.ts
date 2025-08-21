import { Hono } from 'hono';
import { CachedMatches } from '../types/match';
import { env } from '../config/environment';
import { fetchLeaderboard, processPlayersMatches } from '../services/ninjakiwi';

export const matches = new Hono();

let cachedMatches: CachedMatches | null = null;
let isCurrentlyFetching = false;

async function getMatches() {
    try {
        console.log('Starting to get matches...');
        const leaderboardData = await fetchLeaderboard(34);

        if (!leaderboardData || leaderboardData.length === 0) {
            console.log('No leaderboard data available');
            throw new Error('No leaderboard data available');
        }

        const allMatches = await processPlayersMatches(leaderboardData);

        console.log(`Total unique matches found: ${allMatches.length}`);
        return {
            totalMatches: allMatches.length,
            matches: allMatches,
        };
    } catch (error) {
        console.error('Error in getMatches:', error);
        throw error;
    }
}

async function updateCache() {
    if (isCurrentlyFetching) {
        console.log('Already fetching data, skipping...');
        return;
    }

    isCurrentlyFetching = true;
    console.log(`[${new Date().toISOString()}] Starting scheduled data fetch...`);

    try {
        const result = await getMatches();

        cachedMatches = {
            ...result,
            lastUpdated: new Date(),
        };

        console.log(
            `[${new Date().toISOString()}] Cache updated successfully. ${result.totalMatches} matches stored.`
        );
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Failed to update cache:`, error);
    } finally {
        isCurrentlyFetching = false;
    }
}

matches.get('/', async (c) => {
    if (cachedMatches) {
        return c.json({
            ...cachedMatches,
            lastUpdated: cachedMatches.lastUpdated.toISOString(),
            source: 'cache',
        });
    } else {
        return c.json({
            error: 'No data available yet. Data is being fetched in the background.',
            message: 'Please try again in a few minutes.',
        });
    }
});

matches.get('/status', (c) => {
    return c.json({
        status: 'running',
        hasCache: !!cachedMatches,
        isCurrentlyFetching,
        lastUpdated: cachedMatches?.lastUpdated?.toISOString() || null,
        nextUpdateIn: cachedMatches
            ? Math.max(
                  0,
                  env.NK_FETCH_INTERVAL - (Date.now() - cachedMatches.lastUpdated.getTime())
              )
            : 'unknown',
        timestamp: new Date().toISOString(),
    });
});

matches.get('/force-update', async (c) => {
    if (isCurrentlyFetching) {
        return c.json({ message: 'Update already in progress' });
    }

    updateCache();

    return c.json({ message: 'Force update triggered. Check /status for progress.' });
});

async function onServerStart() {
    console.log('Server starting...');

    console.log('Performing initial data fetch...');
    await updateCache();

    setInterval(updateCache, env.NK_FETCH_INTERVAL);
    console.log(`Scheduled updates every ${env.NK_FETCH_INTERVAL / 1000} seconds`);

    console.log('Server ready!');
}

onServerStart().catch(console.error);
