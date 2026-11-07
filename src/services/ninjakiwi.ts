import { MAX_SEASON_PAGES, PLAYER_FETCH_CONCURRENCY } from '@/config/crawler';
import { NK_API } from '@/config/nk';
import type { LeaderboardPlayer, LeaderboardResponse } from '@/types/leaderboard';
import type { Match } from '@/types/match';
import type {
    CrawlOptions,
    CrawlResult,
    HistoryOptions,
    NkAnswer,
    NkUserId,
    PlayerHistory,
} from '@/types/ninjakiwi';
import type { PlayerMatchesResponse } from '@/types/player';
import type { Season, SeasonsResponse } from '@/types/season';
import { fetchNk, fetchWithRetry, type Priority } from '@/utils/helpers';
import { logger } from '@/utils/logger';

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
        const data: SeasonsResponse | null = await fetchWithRetry(url, { priority: 'normal' });

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
): Promise<LeaderboardResponse | null> {
    const label = `season ${seasonId} leaderboard page ${pageNb}`;
    const data: LeaderboardResponse | null = await fetchWithRetry(
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

/** Every page NK has: `maxPages` when it sends one, otherwise `next` until there is none. */
export async function fetchLeaderboard(
    seasonId: number,
    priority: Priority = 'normal',
): Promise<LeaderboardPlayer[]> {
    const started = Date.now();
    const first = await fetchLeaderboardPage(seasonId, 1, priority);
    if (!first) return [];

    const players: LeaderboardPlayer[] = [...(first.body ?? [])];
    const maxPages = Number(first.maxPages) || 0;

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
        // a `next` seen before would loop forever
        const seen = new Set<string>([first.next]);
        for (let pageNb = 2; ; pageNb++) {
            const page = await fetchLeaderboardPage(seasonId, pageNb, priority);
            if (!page) break;
            players.push(...(page.body ?? []));
            if (!page.next || seen.has(page.next)) break;
            seen.add(page.next);
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

/** status "failed": NK did not answer (even after retries) or answered with an error. */
async function fetchMatches(
    userId: NkUserId,
    etag: string | null,
): Promise<NkAnswer<PlayerMatchesResponse>> {
    const answer = await fetchNk<PlayerMatchesResponse>(NK_API.PLAYER_MATCHES(userId), {
        priority: 'low',
        retries: 4,
        etag,
    });
    if (answer.status !== 'ok') {
        if (answer.status === 'failed') logger.warn(`No response for matches of user ${userId}`);
        return answer;
    }
    const data = answer.data;
    if (!data || !data.success || data.error) {
        logger.warn(`Matches of user ${userId} failed: ${data?.error ?? 'unsuccessful'}`);
        return { ...answer, data: null, status: 'failed' };
    }
    return answer;
}

export async function fetchPlayerHistory(
    userId: NkUserId,
    { isStored, hasHistory, filter, etag = null }: HistoryOptions,
): Promise<PlayerHistory> {
    const answer = await fetchMatches(userId, etag);
    const read = { etag: answer.etag, ageS: answer.ageS, gap: false };
    if (answer.status === 'failed') return { ...read, matches: [], ok: false, unchanged: false };
    if (answer.status === 'unchanged' || !answer.data) {
        return { ...read, matches: [], ok: true, unchanged: true };
    }

    const matches = (answer.data.body ?? []).filter(filter);
    if (matches.length === 0) return { ...read, matches, ok: true, unchanged: false };

    // gap check only: a database hiccup here must not cost us the matches themselves
    try {
        const stored = await isStored(matches.map((m) => m.id));
        const gap = stored.size === 0 && (await hasHistory(userId));
        return { ...read, matches, ok: true, unchanged: false, gap };
    } catch (error) {
        logger.warn(`Gap check of user ${userId} failed: ${error}`);
        return { ...read, matches, ok: true, unchanged: false };
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
    userIds: NkUserId[],
    options: CrawlOptions,
): Promise<CrawlResult> {
    const {
        isStored,
        hasHistory,
        filter = () => true,
        concurrency = PLAYER_FETCH_CONCURRENCY,
        etagOf = () => null,
        onPlayer,
        onProgress,
    } = options;

    const matches = new Map<string, Match>();
    const failed: NkUserId[] = [];
    const gaps: NkUserId[] = [];
    let done = 0;
    let lastReport = 0;

    await forEachWithConcurrency(userIds, concurrency, async (userId) => {
        let history: PlayerHistory;
        try {
            const etag = etagOf(userId);
            history = await fetchPlayerHistory(userId, { isStored, hasHistory, filter, etag });
        } catch (error) {
            logger.error(`Reading matches of user ${userId} failed: ${error}`);
            history = {
                matches: [],
                ok: false,
                unchanged: false,
                etag: null,
                ageS: null,
                gap: false,
            };
        }
        onPlayer?.(userId, history);

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
