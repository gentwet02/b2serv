import { CachedMatches } from '@/types/match';
import { fetchLeaderboard, getLiveSeasonId, processPlayersMatches } from '@/services/ninjakiwi';
import { logger } from '@/utils/logger';

async function getMatchesHistory() {
    try {
        logger.debug('Starting to get matches...');
        const seasonId = await getLiveSeasonId();
        const leaderboardData = await fetchLeaderboard(seasonId);

        if (!leaderboardData || leaderboardData.length === 0) {
            logger.debug('No leaderboard data available');
            throw new Error('No leaderboard data available');
        }

        const allMatches = await processPlayersMatches(leaderboardData);

        logger.debug(`Total unique matches found: ${allMatches.length}`);
        return {
            totalMatches: allMatches.length,
            matches: allMatches,
            seasonID: seasonId,
        };
    } catch (error) {
        logger.error(`Error in getMatchesHistory: ${error}`);
        throw error;
    }
}

export async function updateMatchesHistoryCache(
    isCurrentlyFetching: boolean,
    cachedMatches: CachedMatches | null
): Promise<[isCurrentlyFetching: boolean, cachedMatches: CachedMatches | null]> {
    if (isCurrentlyFetching) {
        logger.debug('Already fetching data, skipping...');
        return [isCurrentlyFetching, cachedMatches];
    }

    isCurrentlyFetching = true;
    logger.debug(`[${new Date().toISOString()}] Starting scheduled data fetch...`);

    try {
        const result = await getMatchesHistory();

        cachedMatches = {
            ...result,
            lastUpdated: new Date(),
        };

        logger.debug(
            `[${new Date().toISOString()}] Cache updated successfully. ${result.totalMatches} matches stored.`
        );
    } catch (error) {
        logger.error(`[${new Date().toISOString()}] Failed to update cache: ${error}`);
    } finally {
        isCurrentlyFetching = false;
    }

    return [isCurrentlyFetching, cachedMatches];
}
