import { env } from '@/config/environment';
import { processPlayersMatches, type CrawlProgress } from '@/services/ninjakiwi';
import { getLeaderboardPlayers } from '@/services/leaderboard';
import { rememberMatchAssets } from '@/services/matchMeta';
import { saveCrawledMatches } from '@/services/matchStore';
import { getLiveSeason } from '@/services/seasons';
import type { Match } from '@/types/match';
import { logger } from '@/utils/logger';

/**
 * The crawler only feeds the database: every HoM player's recent matches are read from NK
 * and new ones are stored as they are found (in batches), with image URLs.
 * Visitors read the database (services/matchStore.ts), never the crawler.
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
};

const isRanked = (match: Match) => match.gametype === 'Ranked';

async function storeBatch(batch: Match[], seasonId: number) {
    if (batch.length === 0) return;
    await rememberMatchAssets(batch);
    const saved = await saveCrawledMatches(batch, seasonId);
    crawlState.inserted += saved.inserted;
    crawlState.rejected += saved.invalid;
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
        crawlState.found = found.size;
        writing = writing
            .then(() => storeBatch(batch, seasonId))
            .catch((error) => logger.error(`Storing a match batch failed: ${error}`));
    };

    try {
        const players = await getLeaderboardPlayers(season);
        if (players.length === 0) throw new Error(`Empty leaderboard for season ${seasonId}`);
        crawlState.progress = { done: 0, total: players.length };

        await processPlayersMatches(
            players,
            (found, progress) => {
                crawlState.progress = progress;
                flush(found);
            },
            isRanked,
        );
        await writing;

        logger.debug(
            `Match crawl: ${crawlState.found} ranked matches seen, ${crawlState.inserted} new, ${crawlState.rejected} rejected`,
        );
    } catch (error) {
        crawlState.lastError = String(error);
        logger.error(`Match crawl failed: ${error}`);
    } finally {
        await writing;
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
