import { env } from '@/config/environment';
import {
    CRAWL_CONCURRENCY,
    CRAWL_RETRY_PASSES,
    CRAWL_RETRY_PAUSE_MS,
    MAX_UNSAVED,
    STORE_ATTEMPTS,
} from '@/config/constants';
import { getLeaderboardPlayers } from '@/services/leaderboard';
import { rememberMatchAssets } from '@/services/matchMeta';
import { findStoredIds, saveCrawledMatches } from '@/services/matchStore';
import { processPlayersMatches } from '@/services/ninjakiwi';
import { getLiveSeason } from '@/services/seasons';
import type { Match } from '@/types/match';
import type { CrawlProgress } from '@/types/ninjakiwi';
import { logger } from '@/utils/logger';
import { delay, extractUserId } from '@/utils/helpers';

/**
 * The crawler only feeds the database: every HoM player's matches are read from NK and
 * new ones are stored as they are found (in batches), with image URLs.
 * Visitors read the database (services/matchStore.ts), never the crawler.
 *
 * Safety net, so a match is not lost because one request or one write failed:
 *  - each player's history is paged back until it meets matches already stored
 *    (services/ninjakiwi.ts → fetchPlayerHistory), so gaps fill themselves on the next run;
 *  - players NK did not answer for are read again at the end of the run, after a pause,
 *    and the ones still failing are read first on the next run;
 *  - a failed database write is retried, then kept in memory for the next run.
 * The pace stays slow on purpose: the rate limiter (NK_REQUESTS_PER_SECOND) sets it.
 */

export const crawlState = {
    isFetching: false,
    seasonId: null as number | null,
    progress: null as CrawlProgress | null,
    lastRunStartedAt: null as Date | null,
    lastRunEndedAt: null as Date | null,
    lastError: null as string | null,
    found: 0,
    inserted: 0,
    rejected: 0,
    // safety net, for the current / last run
    /** NK match pages read */
    pages: 0,
    /** players read again after a failed request */
    retriedPlayers: 0,
    /** players still unreadable at the end of the run (read first on the next one) */
    failedPlayers: 0,
    /** players whose history went past MATCH_HISTORY_MAX_PAGES without meeting a stored match */
    truncatedPlayers: 0,
    /** matches whose database write failed, waiting for the next run */
    unsaved: 0,
};

const isRanked = (match: Match) => match.gametype === 'Ranked';

/** Players NK did not answer for, by season: read first on the next run. */
const pendingPlayers = new Map<number, Set<string>>();
/** Matches whose write failed, by season: written first on the next run. */
const unsavedMatches = new Map<number, Map<string, Match>>();

function countUnsaved() {
    let n = 0;
    for (const matches of unsavedMatches.values()) n += matches.size;
    return n;
}

function keepUnsaved(batch: Match[], seasonId: number) {
    const kept = unsavedMatches.get(seasonId) ?? new Map<string, Match>();
    for (const match of batch) {
        if (countUnsaved() + kept.size >= MAX_UNSAVED) {
            logger.error(`Unsaved match buffer full (${MAX_UNSAVED}): dropping match ${match.id}`);
            continue;
        }
        kept.set(match.id, match);
    }
    unsavedMatches.set(seasonId, kept);
    crawlState.unsaved = countUnsaved();
}

/** true when the batch reached the database. */
async function storeBatch(batch: Match[], seasonId: number): Promise<boolean> {
    if (batch.length === 0) return true;

    // image URLs are a nice-to-have: never let them block the matches themselves
    try {
        await rememberMatchAssets(batch);
    } catch (error) {
        logger.warn(`Remembering match assets failed: ${error}`);
    }

    for (let attempt = 1; attempt <= STORE_ATTEMPTS; attempt++) {
        try {
            const saved = await saveCrawledMatches(batch, seasonId);
            crawlState.inserted += saved.inserted;
            crawlState.rejected += saved.invalid;
            return true;
        } catch (error) {
            logger.warn(
                `Storing ${batch.length} match(es) failed (attempt ${attempt}/${STORE_ATTEMPTS}): ${error}`,
            );
            if (attempt < STORE_ATTEMPTS) await delay(5_000 * attempt);
        }
    }
    logger.error(`Storing ${batch.length} match(es) gave up: kept for the next run`);
    return false;
}

/** Writes the matches a previous run could not store. */
async function retryUnsaved() {
    for (const [seasonId, matches] of [...unsavedMatches]) {
        if (matches.size === 0) continue;
        logger.info(`Match crawl: writing ${matches.size} match(es) left from a previous run`);
        const ok = await storeBatch([...matches.values()], seasonId);
        if (ok) unsavedMatches.delete(seasonId);
    }
    crawlState.unsaved = countUnsaved();
}

export async function refreshMatchesHistory(): Promise<void> {
    if (crawlState.isFetching) {
        logger.debug('Match crawl already running, skipping');
        return;
    }

    const season = getLiveSeason();
    if (!season) {
        crawlState.lastError = 'Live season not available';
        logger.error('Match crawl: no live season available');
        return;
    }

    const seasonId = season.seasonId;
    Object.assign(crawlState, {
        isFetching: true,
        seasonId,
        progress: null,
        lastError: null,
        lastRunStartedAt: new Date(),
        found: 0,
        inserted: 0,
        rejected: 0,
        pages: 0,
        retriedPlayers: 0,
        failedPlayers: 0,
        truncatedPlayers: 0,
    });
    logger.debug(`Match crawl: starting for season ${seasonId}`);

    // matches already handed to storeBatch during this run
    const stored = new Set<string>();
    // batches are written one after another, never in parallel
    let writing: Promise<void> = Promise.resolve();

    const flush = (found: Map<string, Match>) => {
        const batch: Match[] = [];
        for (const [id, match] of found) {
            if (!stored.has(id)) {
                stored.add(id);
                batch.push(match);
            }
        }
        crawlState.found = stored.size;
        if (batch.length === 0) return;
        writing = writing
            .then(async () => {
                if (!(await storeBatch(batch, seasonId))) keepUnsaved(batch, seasonId);
            })
            .catch((error) => {
                logger.error(`Storing a match batch failed: ${error}`);
                keepUnsaved(batch, seasonId);
            });
    };

    const isStored = (ids: string[]) => findStoredIds(ids, seasonId);

    const runPass = async (userIds: string[]) => {
        crawlState.progress = { done: 0, total: userIds.length };
        const result = await processPlayersMatches(userIds, {
            isStored,
            filter: isRanked,
            concurrency: CRAWL_CONCURRENCY,
            onProgress: (found, progress) => {
                crawlState.progress = progress;
                flush(found);
            },
        });
        flush(result.matches);
        crawlState.pages += result.pages;
        crawlState.truncatedPlayers += result.truncated.length;
        if (result.truncated.length > 0) {
            logger.warn(
                `Match crawl: history of ${result.truncated.length} player(s) went past the page limit, older matches may be missing: ${result.truncated.slice(0, 20).join(', ')}`,
            );
        }
        return result.failed;
    };

    try {
        await retryUnsaved();

        const players = await getLeaderboardPlayers(season);
        if (players.length === 0) throw new Error(`Empty leaderboard for season ${seasonId}`);

        // players left over from the previous run first, then the leaderboard
        const pending = pendingPlayers.get(seasonId) ?? new Set<string>();
        const userIds = [
            ...new Set([...pending, ...players.map((p) => extractUserId(p.profile))]),
        ].filter(Boolean);
        pendingPlayers.delete(seasonId);

        let failed = await runPass(userIds);

        for (let pass = 1; failed.length > 0 && pass <= CRAWL_RETRY_PASSES; pass++) {
            const wait = CRAWL_RETRY_PAUSE_MS * pass;
            logger.warn(
                `Match crawl: no answer for ${failed.length} player(s), retry ${pass}/${CRAWL_RETRY_PASSES} in ${wait / 1000}s`,
            );
            await delay(wait);
            crawlState.retriedPlayers += failed.length;
            failed = await runPass(failed);
        }

        crawlState.failedPlayers = failed.length;
        if (failed.length > 0) {
            pendingPlayers.set(seasonId, new Set(failed));
            logger.error(
                `Match crawl: ${failed.length} player(s) still unanswered, read first next run`,
            );
        }

        await writing;

        logger.info(
            `Match crawl: ${crawlState.found} ranked matches seen, ${crawlState.inserted} new, ${crawlState.rejected} rejected, ` +
                `${crawlState.pages} pages, ${crawlState.retriedPlayers} retried, ${crawlState.failedPlayers} failed, ` +
                `${crawlState.truncatedPlayers} truncated, ${crawlState.unsaved} unsaved`,
        );
    } catch (error) {
        crawlState.lastError = String(error);
        logger.error(`Match crawl failed: ${error}`);
    } finally {
        await writing;
        crawlState.unsaved = countUnsaved();
        crawlState.isFetching = false;
        crawlState.lastRunEndedAt = new Date();
    }
}

/** ms until the next crawl may start (crawls are spaced from the end of the previous one) */
export function nextCrawlInMs(): number | null {
    if (crawlState.isFetching) return null;
    const ended = crawlState.lastRunEndedAt?.getTime();
    return ended ? Math.max(0, ended + env.NK_MATCHES_INTERVAL - Date.now()) : 0;
}
