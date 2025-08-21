import { LeaderboardPlayer } from '../types/leaderboard';
import { Match } from '../types/match';
import { extractUserId, fetchWithRetry } from '../utils/helpers';

async function fetchLeaderboardPage(seasonId: number, pageNb: number) {
    console.log(`Fetching leaderboard page ${pageNb}...`);
    const url = `https://data.ninjakiwi.com/battles2/homs/season_${seasonId}/leaderboard?page=${pageNb}`;
    const data = await fetchWithRetry(url);

    if (data) {
        console.log(`Got ${data.body?.length || 0} players from leaderboard page ${pageNb}`);
    }

    return data;
}

export async function fetchLeaderboard(seasonId: number) {
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
