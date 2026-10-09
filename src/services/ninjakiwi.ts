import {
    NK_API,
    MAX_SEASON_PAGES,
    MAX_LEADERBOARD_PAGES,
    PLAYER_FETCH_CONCURRENCY,
} from '@/config/constants';
import { fetchWithRetry, type Priority } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import type { LeaderboardPlayer, LeadrboardResponse } from '@/types/leaderboard';
import type { Match } from '@/types/match';
import type { CrawlOptions, CrawlResult, HistoryOptions, PlayerHistory } from '@/types/ninjakiwi';
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
// One player's matches. NK only serves the last ~24 matches, with no paging:
// anything older is gone, so the only safety net is reading every player often
// enough, and noticing when we didn't (a "gap").
// ---------------------------------------------------------------------------

/** null: NK did not answer, even after retries. */
async function fetchMatches(userId: string): Promise<PlayerMatchesResponse | null> {
    const data: PlayerMatchesResponse | null = await fetchWithRetry(NK_API.PLAYER_MATCHES(userId), {
        priority: 'low',
        retries: 4,
    });

    if (!data) {
        logger.warn(`No response for matches of user ${userId}`);
        return null;
    }
    if (!data.success || data.error) {
        logger.warn(`Matches of user ${userId} failed: ${data.error ?? 'unsuccessful'}`);
        return null;
    }
    return data;
}

export async function fetchPlayerHistory(
    userId: string,
    { isStored, hasHistory, filter }: HistoryOptions,
): Promise<PlayerHistory> {
    const data = await fetchMatches(userId);
    if (!data) return { matches: [], ok: false, gap: false };

    const matches = (data.body ?? []).filter(filter);
    if (matches.length === 0) return { matches, ok: true, gap: false };

    // gap check only: a database hiccup here must not cost us the matches themselves
    try {
        const stored = await isStored(matches.map((m) => m.id));
        const gap = stored.size === 0 && (await hasHistory(userId));
        return { matches, ok: true, gap };
    } catch (error) {
        logger.warn(`Gap check of user ${userId} failed: ${error}`);
        return { matches, ok: true, gap: false };
    }
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
        hasHistory,
        filter = () => true,
        concurrency = PLAYER_FETCH_CONCURRENCY,
        onProgress,
    } = options;

    const matches = new Map<string, Match>();
    const failed: string[] = [];
    const gaps: string[] = [];
    let done = 0;
    let lastReport = 0;

    await forEachWithConcurrency(userIds, concurrency, async (userId) => {
        let history: PlayerHistory;
        try {
            history = await fetchPlayerHistory(userId, { isStored, hasHistory, filter });
        } catch (error) {
            logger.error(`Reading matches of user ${userId} failed: ${error}`);
            history = { matches: [], ok: false, gap: false };
        }

        for (const match of history.matches) {
            if (!matches.has(match.id)) matches.set(match.id, match);
        }
        if (!history.ok) failed.push(userId);
        if (history.gap) gaps.push(userId);

        done++;
        const now = Date.now();
        if (done === userIds.length || done % 25 === 0 || now - lastReport > 10_000) {
            lastReport = now;
            onProgress?.(matches, { done, total: userIds.length });
        }
        if (done % 100 === 0 || done === userIds.length) {
            logger.debug(
                `Player matches: ${done}/${userIds.length} players, ${matches.size} unique matches`,
            );
        }
    });

    return { matches, failed, gaps };
}
