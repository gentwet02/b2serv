import {
    NK_API,
    MAX_SEASON_PAGES,
    MAX_LEADERBOARD_PAGES,
    PLAYER_FETCH_CONCURRENCY,
    MATCH_HISTORY_MAX_PAGES,
    MATCH_HISTORY_OVERLAP,
} from '@/config/constants';
import { fetchWithRetry, type Priority } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import type { LeaderboardPlayer, LeadrboardResponse } from '@/types/leaderboard';
import type { HistoryOptions, Match } from '@/types/match';
import type { PlayerHistory, PlayerMatchesResponse } from '@/types/player';
import type { Season, SeasonsResponse } from '@/types/season';
import { CrawlOptions, CrawlResult } from '@/types/ninjakiwi';

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
    pageNb: number,
    priority: Priority,
): Promise<LeadrboardResponse | null> {
    const label = `season ${seasonId} leaderboard page ${pageNb}`;
    const data: LeadrboardResponse | null = await fetchWithRetry(
        NK_API.LEADERBOARD(seasonId, pageNb),
        { priority },
    );

    if (!data) {
        logger.error(`No response for ${label}`);
        return null;
    }
    if (!data.success || data.error) {
        logger.error(`Fetch of ${label} failed: ${data.error ?? 'unsuccessful'}`);
        return null;
    }

    return data;
}

export async function fetchLeaderboard(
    seasonId: number,
    priority: Priority = 'low',
): Promise<LeaderboardPlayer[]> {
    const started = Date.now();
    const first = await fetchLeaderboardPage(seasonId, 1, priority);
    if (!first) return [];

    const players: LeaderboardPlayer[] = [...(first.body ?? [])];
    const maxPages = Math.min(Number(first.maxPages) || 0, MAX_LEADERBOARD_PAGES);

    if (maxPages > 1) {
        const pageNumbers = Array.from({ length: maxPages - 1 }, (_, i) => i + 2);
        const pages = await Promise.all(
            pageNumbers.map((n) => fetchLeaderboardPage(seasonId, n, priority)),
        );
        for (const page of pages) {
            if (!page) break;
            players.push(...(page.body ?? []));
        }
    } else if (first.next) {
        for (let pageNb = 2; pageNb <= MAX_LEADERBOARD_PAGES; pageNb++) {
            const page = await fetchLeaderboardPage(seasonId, pageNb, priority);
            if (!page) break;
            players.push(...(page.body ?? []));
            if (!page.next) break;
        }
    }

    logger.debug(
        `Season ${seasonId}: ${players.length} players in ${((Date.now() - started) / 1000).toFixed(1)}s (${priority})`,
    );
    return players;
}

// ---------------------------------------------------------------------------
// One player's match history, paged until it meets matches we already stored
// ---------------------------------------------------------------------------

/** null: NK did not answer, even after retries. */
async function fetchMatchesPage(
    url: string,
    userId: string,
    pageNb: number,
): Promise<PlayerMatchesResponse | null> {
    const data: PlayerMatchesResponse | null = await fetchWithRetry(url, {
        priority: 'low',
        retries: 4,
    });

    if (!data) {
        logger.warn(`No response for matches of user ${userId} (page ${pageNb})`);
        return null;
    }
    if (!data.success || data.error) {
        logger.warn(
            `Matches of user ${userId} (page ${pageNb}) failed: ${data.error ?? 'unsuccessful'}`,
        );
        return null;
    }
    return data;
}

/**
 * Reads a player's matches newest first, page after page, until MATCH_HISTORY_OVERLAP
 * matches in a row are already stored: from there on, an earlier crawl has them.
 * Whatever happened in between (failed request, server restart, a player grinding many
 * games between two crawls) is filled in on the next run instead of being lost.
 */
export async function fetchPlayerHistory(
    userId: string,
    { isStored, filter, maxPages }: HistoryOptions,
): Promise<PlayerHistory> {
    const matches: Match[] = [];
    let url: string | null = NK_API.PLAYER_MATCHES(userId);
    let pages = 0;
    let storedInARow = 0;

    while (url && pages < maxPages) {
        const data = await fetchMatchesPage(url, userId, pages + 1);
        if (!data) return { matches, pages, ok: false, complete: false };
        pages++;

        const body = data.body ?? [];
        if (body.length === 0) return { matches, pages, ok: true, complete: true };

        // unranked matches are never stored: they neither prove nor break the overlap
        const kept = body.filter(filter);
        matches.push(...kept);

        if (kept.length > 0) {
            let stored: Set<string>;
            try {
                stored = await isStored(kept.map((m) => m.id));
            } catch (error) {
                logger.warn(`Checking stored matches of user ${userId} failed: ${error}`);
                return { matches, pages, ok: false, complete: false };
            }
            for (const match of kept) {
                storedInARow = stored.has(match.id) ? storedInARow + 1 : 0;
                if (storedInARow >= MATCH_HISTORY_OVERLAP) {
                    return { matches, pages, ok: true, complete: true };
                }
            }
        }

        url = nextPageUrl(data.next);
        if (data.next && !url) {
            logger.error(
                `Unrecognised "next" format in matches of user ${userId}: ${JSON.stringify(data.next)}`,
            );
        }
    }

    return { matches, pages, ok: true, complete: url === null };
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

export async function processPlayersMatches(
    userIds: string[],
    options: CrawlOptions,
): Promise<CrawlResult> {
    const {
        isStored,
        filter = () => true,
        concurrency = PLAYER_FETCH_CONCURRENCY,
        maxPages = MATCH_HISTORY_MAX_PAGES,
        onProgress,
    } = options;

    const matches = new Map<string, Match>();
    const failed: string[] = [];
    const truncated: string[] = [];
    let pages = 0;
    let done = 0;
    let lastReport = 0;

    await forEachWithConcurrency(userIds, concurrency, async (userId) => {
        let history: PlayerHistory;
        try {
            history = await fetchPlayerHistory(userId, { isStored, filter, maxPages });
        } catch (error) {
            logger.error(`Reading matches of user ${userId} failed: ${error}`);
            history = { matches: [], pages: 0, ok: false, complete: false };
        }

        pages += history.pages;
        for (const match of history.matches) {
            if (!matches.has(match.id)) matches.set(match.id, match);
        }
        if (!history.ok) failed.push(userId);
        else if (!history.complete) truncated.push(userId);

        done++;
        const now = Date.now();
        if (done === userIds.length || done % 25 === 0 || now - lastReport > 10_000) {
            lastReport = now;
            onProgress?.(matches, { done, total: userIds.length });
        }
        if (done % 100 === 0 || done === userIds.length) {
            logger.debug(
                `Player matches: ${done}/${userIds.length} players, ${pages} pages, ${matches.size} unique matches`,
            );
        }
    });

    return { matches, failed, truncated, pages };
}
