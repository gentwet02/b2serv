import { CachedMatches } from '../types/match';
import { fetchLeaderboard, getLiveSeasonId, processPlayersMatches } from './ninjakiwi';

async function getMatchesHistory() {
    try {
        console.log('Starting to get matches...');
        const seasonId = await getLiveSeasonId();
        const leaderboardData = await fetchLeaderboard(seasonId);

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
        console.error('Error in getMatchesHistory:', error);
        throw error;
    }
}

export async function updateMatchesHistoryCache(
    isCurrentlyFetching: boolean,
    cachedMatches: CachedMatches | null
): Promise<[isCurrentlyFetching: boolean, cachedMatches: CachedMatches | null]> {
    if (isCurrentlyFetching) {
        console.log('Already fetching data, skipping...');
        return [isCurrentlyFetching, cachedMatches];
    }

    isCurrentlyFetching = true;
    console.log(`[${new Date().toISOString()}] Starting scheduled data fetch...`);

    try {
        const result = await getMatchesHistory();

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

    return [isCurrentlyFetching, cachedMatches];
}
