import { NK_API } from '../config/constants';
import { extractSeasonId, extractUserId, fetchWithRetry } from '../utils/helpers';
import { logger } from '../utils/logger';
import type { LeaderboardPlayer, LeadrboardResponse } from '../types/leaderboard';
import type { Match } from '../types/match';
import type { PlayerMatchesResponse } from '../types/player';
import type { Season, SeasonsResponse } from '../types/season';

export async function getLiveSeasonId(): Promise<number> {
    try {
        logger.debug('Looking for live season...');
        const seasonsData = await fetchSeasons();

        if (!seasonsData || seasonsData.length === 0) {
            logger.error('No seasons data available');
            throw new Error('No seasons data available');
        }
        const liveSeason = seasonsData.filter((season) => season.live)[0];
        return extractSeasonId(liveSeason.name);
    } catch (error) {
        logger.error('Could not get live season:', { error });
        throw error;
    }
}

export async function fetchSeasons(): Promise<Season[]> {
    logger.debug('Fetching seaons list...');

    const url = NK_API.SEASONS;
    const data: SeasonsResponse = await fetchWithRetry(url);

    if (data.error) {
        logger.error(`Error while fetching seasons list: ${data.error}`);
    }

    if (!data.success) {
        logger.error('Fetch of seasons list was not successful');
    }

    logger.debug(`Total seasons found: ${data?.body?.length || 0}`);

    // todo: maybe one day there will be more than one page if that matters ...

    return data.body || [];
}

async function fetchLeaderboardPage(seasonId: number, pageNb = 1): Promise<LeadrboardResponse> {
    const lbPage = `leaderboard page ${pageNb}`;
    logger.debug(`Fetching ${lbPage}...`);

    const url = NK_API.LEADERBOARD(seasonId, pageNb);
    const data: LeadrboardResponse = await fetchWithRetry(url);

    if (data.error) {
        logger.error(`Error while fetching ${lbPage}: ${data.error}`);
    }

    if (!data.success) {
        logger.error(`Fetch of ${lbPage} was not successful`);
    }

    logger.debug(`Got ${data?.body?.length || 0} players from ${lbPage}`);

    return data;
}

export async function fetchLeaderboard(seasonId: number): Promise<LeaderboardPlayer[]> {
    console.log(`Fetching leaderboard for season ${seasonId}...`);
    const players: LeaderboardPlayer[] = [];
    let pageNb = 1;
    let hasMorePages = true;

    while (hasMorePages) {
        const pageData = await fetchLeaderboardPage(seasonId, pageNb);

        if (!pageData) {
            logger.error(`Could not fetch leaderboard page ${pageNb}, stopping...`);
            break;
        }

        if (pageData?.body?.length > 0) {
            players.push(...pageData.body);
        }

        if (pageData.next) {
            pageNb += 1;
        } else {
            hasMorePages = false;
        }
    }

    logger.debug(`Total players found: ${players.length}`);
    return players;
}

async function fetchPlayerMatches(userId: string): Promise<Match[]> {
    const mUser = `matches for user ${userId}`;
    logger.debug(`Fetching ${mUser}...`);
    const url = NK_API.PLAYER_MATCHES(userId);
    const data: PlayerMatchesResponse = await fetchWithRetry(url);

    if (data.error) {
        logger.error(`Error while fetching ${mUser}: ${data.error}`);
    }

    if (!data.success) {
        logger.error(`Fetch ${mUser} was not successful`);
    }

    console.log(`Got ${data?.body?.length || 0} matches for user ${userId}`);

    return data.body || [];
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

export async function processPlayersMatches(players: LeaderboardPlayer[]) {
    const matches: Match[] = [];
    const seenIds = new Set<string>();

    const matchPromises = players.map(async (player: LeaderboardPlayer) => {
        await processPlayerMatches(player, matches, seenIds);
    });

    await Promise.all(matchPromises);
    return matches;
}
