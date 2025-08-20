import { Hono } from 'hono';
import type { LeaderboardPlayer, Match } from './types';

const app = new Hono();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRIES = 5;
const FETCH_INTERVAL_MS = 5 * 60 * 1000;

let cachedData: {
    totalMatches: number;
    matches: Match[];
    lastUpdated: Date;
} | null = null;

let isCurrentlyFetching = false;

async function fetchWithRetry(url: string, retries = RETRIES) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error(`Fetch failed for ${url} (attempt ${attempt}):`, error);

            if (attempt < retries) {
                const backoffTime = attempt * 500;
                console.log(`Retrying in ${backoffTime}ms...`);
                await delay(backoffTime);
            }
        }
    }

    console.error(`Failed to fetch ${url} after ${retries} attempts`);
    return null;
}

async function fetchLeaderboardPage(seasonId: number, pageNb: number) {
    console.log(`Fetching leaderboard page ${pageNb}...`);
    const url = `https://data.ninjakiwi.com/battles2/homs/season_${seasonId}/leaderboard?page=${pageNb}`;
    const data = await fetchWithRetry(url);

    if (data) {
        console.log(`Got ${data.body?.length || 0} players from leaderboard page ${pageNb}`);
    }

    return data;
}

async function fetchLeaderboard(seasonId: number) {
    console.log(`Fetching leaderboard for season ${seasonId}...`);
    const players: LeaderboardPlayer[] = [];
    let pageNb = 1;
    let hasMorePages = true;

    while (hasMorePages) {
        const pageData = await fetchLeaderboardPage(seasonId, pageNb);

        if (!pageData) {
            console.error(`Could not fetch leaderboard page ${pageNb}, stopping...`);
            break;
        }

        if (pageData.body && pageData.body.length > 0) {
            players.push(...pageData.body);
        }

        if (pageData.next) {
            pageNb += 1;
        } else {
            hasMorePages = false;
        }
    }

    console.log(`Total players found: ${players.length}`);
    return players;
}

async function fetchPlayerMatches(userId: string) {
    console.log(`Fetching matches for user ${userId}...`);
    const url = `https://data.ninjakiwi.com/battles2/users/${userId}/matches`;
    const data = await fetchWithRetry(url);

    if (data) {
        console.log(`Got ${data.body?.length || 0} matches for user ${userId}`);
        return data.body || [];
    }

    return [];
}

function extractUserId(profileUrl: string) {
    return profileUrl.replace('https://data.ninjakiwi.com/battles2/users/', '');
}

function addUniqueMatches(playerMatches: Match[], allMatches: Match[], seenMatchIds: Set<string>) {
    playerMatches.forEach((match: Match) => {
        if (!seenMatchIds.has(match.id)) {
            seenMatchIds.add(match.id);
            allMatches.push(match);
        }
    });
}

async function processPlayerMatches(
    player: LeaderboardPlayer,
    matches: Match[],
    seenIds: Set<string>
) {
    const userId = extractUserId(player.profile);
    const playerMatches = await fetchPlayerMatches(userId);
    addUniqueMatches(playerMatches, matches, seenIds);
}

async function processPlayersMatches(players: LeaderboardPlayer[]) {
    const matches: Match[] = [];
    const seenIds = new Set<string>();

    const matchPromises = players.map(async (player: LeaderboardPlayer) => {
        await processPlayerMatches(player, matches, seenIds);
    });

    await Promise.all(matchPromises);
    return matches;
}

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

        cachedData = {
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

app.get('/', async (c) => {
    if (cachedData) {
        return c.json({
            ...cachedData,
            lastUpdated: cachedData.lastUpdated.toISOString(),
            source: 'cache',
        });
    } else {
        return c.json({
            error: 'No data available yet. Data is being fetched in the background.',
            message: 'Please try again in a few minutes.',
        });
    }
});

app.get('/status', (c) => {
    return c.json({
        status: 'running',
        hasCache: !!cachedData,
        isCurrentlyFetching,
        lastUpdated: cachedData?.lastUpdated?.toISOString() || null,
        nextUpdateIn: cachedData
            ? Math.max(0, FETCH_INTERVAL_MS - (Date.now() - cachedData.lastUpdated.getTime()))
            : 'unknown',
        timestamp: new Date().toISOString(),
    });
});

app.get('/force-update', async (c) => {
    if (isCurrentlyFetching) {
        return c.json({ message: 'Update already in progress' });
    }

    updateCache();

    return c.json({ message: 'Force update triggered. Check /status for progress.' });
});

async function startServer() {
    console.log('Server starting...');

    console.log('Performing initial data fetch...');
    await updateCache();

    setInterval(updateCache, FETCH_INTERVAL_MS);
    console.log(`Scheduled updates every ${FETCH_INTERVAL_MS / 1000} seconds`);

    console.log('Server ready!');
}

startServer().catch(console.error);

export default app;
