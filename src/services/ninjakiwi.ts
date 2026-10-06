import {
    NK_API,
    MAX_SEASON_PAGES,
    MAX_LEADERBOARD_PAGES,
    PLAYER_FETCH_CONCURRENCY,
} from '@/config/constants';
import { extractUserId, fetchWithRetry } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import type { LeaderboardPlayer, LeadrboardResponse } from '@/types/leaderboard';
import type { Match } from '@/types/match';
import type { PlayerMatchesResponse } from '@/types/player';
import type { Season, SeasonsResponse } from '@/types/season';

function nextPageUrl(next: unknown): string | null {
    return typeof next === 'string' && next.length > 0 ? next : null;
}

export async function fetchSeasons(): Promise<Season[]> {
    logger.debug('Fetching seasons list...');
    const seasons: Season[] = [];
    let url: string | null = NK_API.SEASONS;
    let page = 0;

    while (url && page < MAX_SEASON_PAGES) {
        page++;
        const data: SeasonsResponse | null = await fetchWithRetry(url);

        if (!data) {
            logger.error(`No response for seasons page ${page}`);
            break;
        }
        if (!data.success || data.error) {
            logger.error(`Seasons page ${page} failed: ${data.error ?? 'unsuccessful'}`);
            break;
        }

        seasons.push(...(data.body ?? []));
        url = nextPageUrl(data.next);

        if (data.next && !url) {
            logger.error(
                `Unrecognised "next" format on seasons page ${page}: ${JSON.stringify(data.next)}`,
            );
        }
    }

    logger.debug(`Total seasons found: ${seasons.length} (${page} page(s))`);
    return seasons;
}

async function fetchLeaderboardPage(
    seasonId: number,
    pageNb = 1,
): Promise<LeadrboardResponse | null> {
    const label = `season ${seasonId} leaderboard page ${pageNb}`;
    const data: LeadrboardResponse | null = await fetchWithRetry(
        NK_API.LEADERBOARD(seasonId, pageNb),
    );

    if (!data) {
        logger.error(`No response for ${label}`);
        return null;
    }
    if (!data.success || data.error) {
        logger.error(`Fetch of ${label} failed: ${data.error ?? 'unsuccessful'}`);
        return null;
    }

    logger.debug(`Got ${data.body?.length ?? 0} players from ${label}`);
    return data;
}

export async function fetchLeaderboard(seasonId: number): Promise<LeaderboardPlayer[]> {
    logger.debug(`Fetching leaderboard for season ${seasonId}...`);
    const players: LeaderboardPlayer[] = [];

    for (let pageNb = 1; pageNb <= MAX_LEADERBOARD_PAGES; pageNb++) {
        const pageData = await fetchLeaderboardPage(seasonId, pageNb);
        if (!pageData) break;

        players.push(...(pageData.body ?? []));
        if (!pageData.next) break;
    }

    logger.debug(`Season ${seasonId}: ${players.length} players found`);
    return players;
}

async function fetchPlayerMatches(userId: string): Promise<Match[]> {
    const data: PlayerMatchesResponse | null = await fetchWithRetry(NK_API.PLAYER_MATCHES(userId));

    if (!data) {
        logger.error(`No response for matches of user ${userId}`);
        return [];
    }
    if (!data.success || data.error) {
        logger.error(`Fetch of matches for user ${userId} failed: ${data.error ?? 'unsuccessful'}`);
        return [];
    }

    return data.body ?? [];
}

async function forEachWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
) {
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const item = items[index++];
            await fn(item);
        }
    });
    await Promise.all(workers);
}

export async function processPlayersMatches(players: LeaderboardPlayer[]): Promise<Match[]> {
    const matches = new Map<string, Match>();
    let done = 0;

    await forEachWithConcurrency(players, PLAYER_FETCH_CONCURRENCY, async (player) => {
        const playerMatches = await fetchPlayerMatches(extractUserId(player.profile));
        for (const match of playerMatches) {
            if (!matches.has(match.id)) matches.set(match.id, match);
        }

        done++;
        if (done % 100 === 0 || done === players.length) {
            logger.debug(
                `Player matches: ${done}/${players.length} players, ${matches.size} unique matches`,
            );
        }
    });

    return [...matches.values()];
}
