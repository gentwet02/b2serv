import { CachedMatches } from '@/types/match';
import {
    fetchLeaderboard,
    fetchLiveSeason,
    fetchSeasons,
    processPlayersMatches,
} from '@/services/ninjakiwi';
import { logger } from '@/utils/logger';
import { delay, extractSeasonId } from '@/utils/helpers';
import { Season } from '@/types/season';
import { createMatch, getMatchById } from './database';
import { encodeMatch } from '@/utils/encode';

export async function setCachedMatches(
    liveSeason: Season | null,
    isCurrentlyFetching: boolean,
    cachedMatches: CachedMatches | null
): Promise<[boolean, CachedMatches | null]> {
    if (!liveSeason) {
        const seasons = await fetchSeasons();
        liveSeason = await fetchLiveSeason(seasons);
    }

    [isCurrentlyFetching, cachedMatches] = await updateMatchesHistoryCache(
        isCurrentlyFetching,
        cachedMatches,
        liveSeason
    );

    if (!cachedMatches) {
        logger.debug('cachedMatches was null');
        return [isCurrentlyFetching, cachedMatches];
    }

    if (!cachedMatches?.seasonID) {
        logger.error(`cachedMatches has no season id defined`);
        return [isCurrentlyFetching, cachedMatches];
    }

    cachedMatches.matches.map(async (match) => {
        const isAlreadyRegistered = await getMatchById(match.id, cachedMatches!.seasonID);

        if (isAlreadyRegistered) {
            logger.debug(`match ${match.id} was already in the database`);
            return [isCurrentlyFetching, cachedMatches];
        }

        createMatch(
            {
                ...encodeMatch(match),
                t: Date.now(),
            },
            cachedMatches!.seasonID
        );
    });
    return [isCurrentlyFetching, cachedMatches];
}

async function getMatchesHistory(season: Season) {
    try {
        logger.debug('Starting to get matches...');
        const seasonId = extractSeasonId(season.name);
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
    cachedMatches: CachedMatches | null,
    liveSeason: Season | null
): Promise<[isCurrentlyFetching: boolean, cachedMatches: CachedMatches | null]> {
    if (!liveSeason) {
        logger.error('No liveSeason was passed to update the matches history cache');
        return [isCurrentlyFetching, cachedMatches];
    }

    if (isCurrentlyFetching) {
        logger.debug('Already fetching data, skipping...');
        return [isCurrentlyFetching, cachedMatches];
    }

    isCurrentlyFetching = true;
    logger.debug(`[${new Date().toISOString()}] Starting scheduled data fetch...`);

    try {
        delay(100);
        const result = await getMatchesHistory(liveSeason);

        const rankedMatches = result.matches.filter((match) => match.gametype === 'Ranked');

        cachedMatches = {
            totalMatches: rankedMatches.length,
            matches: rankedMatches,
            seasonID: result.seasonID,
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
