import {
    CRAWL_CONCURRENCY,
    CRAWL_RETRY_PASSES,
    CRAWL_RETRY_PAUSE_MS,
    MAX_UNSAVED,
    STORE_ATTEMPTS,
} from '@/config/crawler';
import { env } from '@/config/environment';
import { NK_NO_LEAGUE } from '@/config/nk';
import {
    ensureLeaderboard,
    getCachedLeaderboard,
    getLeaderboardPlayers,
} from '@/services/leaderboard';
import { learnLeagues, loadLeagues, seasonOfLeague } from '@/services/leagueStore';
import { rememberMatchAssets } from '@/services/matchMeta';
import {
    deleteMatches,
    findStoredDates,
    findStoredIds,
    hasStoredMatches,
    saveCrawledMatches,
} from '@/services/matchStore';
import { processPlayersMatches } from '@/services/ninjakiwi';
import { getLiveSeason, getSeasonById } from '@/services/seasons';
import { LeaderboardPlayer } from '@/types/leaderboard';
import type { Match } from '@/types/match';
import type { CrawlProgress, NkUserId } from '@/types/ninjakiwi';
import { delay, extractUserId } from '@/utils/helpers';
import { logger } from '@/utils/logger';

/**
 * The crawler only feeds the database: every HoM player's recent matches are read from NK
 * and new ones are stored as they are found (in batches), with image URLs.
 * Visitors read the database (services/matchStore.ts), never the crawler.
 *
 * NK only serves a player's last ~24 matches, with no paging. A match is kept only if we
 * read the player (or the opponent) before it slips out of that window, so:
 *  - players NK did not answer for are read again at the end of the run, after a pause,
 *    and the ones still failing are read first on the next run;
 *  - a failed database write is retried, then kept in memory for the next run;
 *  - a "gap" is counted when a known player's window holds no stored match at all:
 *    they played past it since our last read, so some matches are lost.
 * Each match is filed under the season of its league (services/leagueStore.ts), not the live
 * one: right after a season change, players' last matches still hold games of the one that ended.
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
    /** players read again after a failed request */
    retriedPlayers: 0,
    /** players still unreadable at the end of the run (read first on the next one) */
    failedPlayers: 0,
    /** known players whose NK window overflowed since the last read (matches lost) */
    gapPlayers: 0,
    /** matches whose database write failed, waiting for the next run */
    unsaved: 0,
    /** ranked matches dropped because a player is not in HoM any more (other arena) */
    notHoM: 0,
    /** ranked matches of another season (their `league`), stored in that season */
    otherSeason: 0,
    /** ranked matches not filed yet: league not learned, or that season's leaderboard not loaded */
    waiting: 0,
};

/**
 * The season a match was played in, from its league. No league: the crawled season (what we
 * did before NK sent one). null: a league not learned yet.
 */
function seasonOfMatch(match: Match, crawled: number): number | null {
    if (!match.league || match.league === NK_NO_LEAGUE) return crawled;
    return seasonOfLeague(match.league);
}

const isRanked = (match: Match) => match.gametype === 'Ranked';

let homIndex: { seasonId: number; updatedAt: Date; ids: Set<string> } | null = null;
const homIds = (players: LeaderboardPlayer[]) =>
    new Set(players.filter((p) => p.currentlyInHoM).map((p) => extractUserId(p.profile)));

function hallOfMasters(seasonId: number): Set<string> | null {
    const entry = getCachedLeaderboard(seasonId);
    if (!entry) return homIndex?.seasonId === seasonId ? homIndex.ids : null;
    if (homIndex?.seasonId !== seasonId || homIndex.updatedAt !== entry.updatedAt) {
        homIndex = { seasonId, updatedAt: entry.updatedAt, ids: homIds(entry.players) };
    }
    return homIndex.ids;
}

function bothInHoM(match: Match, hom: Set<string>) {
    return (
        hom.has(extractUserId(match.playerLeft.profileURL)) &&
        hom.has(extractUserId(match.playerRight.profileURL))
    );
}

/** Players NK did not answer for, by season: read first on the next run. */
const pendingPlayers = new Map<number, Set<NkUserId>>();
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
async function storeBatch(
    batch: Match[],
    seasonId: number,
    seenAt?: (match: Match) => number | undefined,
): Promise<boolean> {
    if (batch.length === 0) return true;

    // image URLs are a nice-to-have: never let them block the matches themselves
    try {
        await rememberMatchAssets(batch);
    } catch (error) {
        logger.warn(`Remembering match assets failed: ${error}`);
    }

    for (let attempt = 1; attempt <= STORE_ATTEMPTS; attempt++) {
        try {
            const saved = await saveCrawledMatches(batch, seasonId, seenAt);
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

/**
 * Stores matches of another season than the crawled one. Before NK's league was read (or while
 * the season list lagged behind), they went into the crawled season: they move out of it,
 * keeping the time they were first seen.
 */
async function storeInOtherSeason(batch: Match[], seasonId: number, crawled: number) {
    const misfiled = await findStoredDates(
        batch.map((m) => m.id),
        crawled,
    );
    if (!(await storeBatch(batch, seasonId, (m) => misfiled.get(m.id)))) return false;
    const moved = await deleteMatches([...misfiled.keys()], crawled);
    if (moved > 0) {
        logger.info(`Match crawl: ${moved} match(es) moved from season ${crawled} to ${seasonId}`);
    }
    return true;
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
        retriedPlayers: 0,
        failedPlayers: 0,
        gapPlayers: 0,
        notHoM: 0,
        otherSeason: 0,
        waiting: 0,
    });
    logger.debug(`Match crawl: starting for season ${seasonId}`);

    // matches already handed to storeBatch during this run
    const stored = new Set<string>();
    // batches are written one after another, never in parallel
    let writing: Promise<void> = Promise.resolve();
    // the roster read at the start of the run, if the cache were ever missing
    let startRoster = new Set<NkUserId>();
    // matches seen but not filed yet (filed by a later flush, at the latest the last one)
    const waiting = new Map<string, Match>();
    // seasons other than the crawled one that got matches this run
    const otherSeasons = new Set<number>();
    const rostersRequested = new Set<number>();

    function rosterOf(target: number): Set<string> | null {
        // read the flags now, after the matches: picks up leaderboard refreshes during the crawl
        if (target === seasonId) return hallOfMasters(seasonId) ?? startRoster;
        const hom = hallOfMasters(target);
        const season = getSeasonById(target);
        if (!hom && season && !rostersRequested.has(target)) {
            rostersRequested.add(target);
            void ensureLeaderboard(season).catch((error) =>
                logger.error(`Loading season ${target} leaderboard failed: ${error}`),
            );
        }
        return hom;
    }

    /** Leagues of the waiting matches that aren't learned yet, with some of their match ids. */
    function unlearned() {
        const leagues = new Map<string, string[]>();
        for (const match of waiting.values()) {
            if (!match.league || seasonOfLeague(match.league) !== null) continue;
            const ids = leagues.get(match.league) ?? [];
            if (ids.length < 50) ids.push(match.id);
            leagues.set(match.league, ids);
        }
        return leagues;
    }

    function flush(found: Map<string, Match>) {
        const batches = new Map<number, Match[]>();
        for (const [id, match] of found) {
            if (stored.has(id)) continue;
            const target = seasonOfMatch(match, seasonId);
            const hom = target === null ? null : rosterOf(target);
            // not marked as stored: the next flush tries again
            if (target === null || !hom) {
                waiting.set(id, match);
                continue;
            }
            waiting.delete(id);
            stored.add(id);
            if (!bothInHoM(match, hom)) {
                crawlState.notHoM++;
                continue;
            }
            if (target !== seasonId) {
                crawlState.otherSeason++;
                otherSeasons.add(target);
            }
            const batch = batches.get(target) ?? [];
            batch.push(match);
            batches.set(target, batch);
        }
        crawlState.found = stored.size + waiting.size;
        crawlState.waiting = waiting.size;
        const leagues = unlearned();
        if (leagues.size > 0) {
            void learnLeagues(leagues).catch((error) =>
                logger.error(`Learning leagues failed: ${error}`),
            );
        }
        for (const [target, batch] of batches) {
            writing = writing
                .then(async () => {
                    const ok =
                        target === seasonId
                            ? await storeBatch(batch, target)
                            : await storeInOtherSeason(batch, target, seasonId);
                    if (!ok) keepUnsaved(batch, target);
                })
                .catch((error) => {
                    logger.error(`Storing a match batch failed: ${error}`);
                    keepUnsaved(batch, target);
                });
        }
    }

    // previous season too: during a season change, a window can hold only its matches
    async function isStored(ids: string[]) {
        const seasons = new Set([seasonId, seasonId - 1, ...otherSeasons]);
        const found = await Promise.all([...seasons].map((id) => findStoredIds(ids, id)));
        return new Set(found.flatMap((set) => [...set]));
    }
    const hasHistory = (userId: string) => hasStoredMatches(userId, seasonId);

    async function runPass(userIds: NkUserId[]) {
        crawlState.progress = { done: 0, total: userIds.length };
        const result = await processPlayersMatches(userIds, {
            isStored,
            hasHistory,
            filter: isRanked,
            concurrency: CRAWL_CONCURRENCY,
            onProgress: (found, progress) => {
                crawlState.progress = progress;
                flush(found);
            },
        });
        flush(result.matches);
        crawlState.gapPlayers += result.gaps.length;
        if (result.gaps.length > 0) {
            logger.warn(
                `Match crawl: ${result.gaps.length} player(s) played past NK's window since the last read, some matches are lost: ${result.gaps.slice(0, 20).join(', ')}`,
            );
        }
        return result.failed;
    }

    try {
        await loadLeagues();
        await retryUnsaved();

        const players = await getLeaderboardPlayers(season);
        if (players.length === 0) throw new Error(`Empty leaderboard for season ${seasonId}`);

        startRoster = homIds(players);
        if (startRoster.size === 0) throw new Error(`Nobody in HoM for season ${seasonId}`);

        // players left over from the previous run first, then the leaderboard
        const pending = [...(pendingPlayers.get(seasonId) ?? [])].filter((id) =>
            startRoster.has(id),
        );
        const userIds = [...new Set([...pending, ...startRoster])].filter(Boolean);
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

        // last chance for the waiting matches: their leagues learned, then filed
        if (waiting.size > 0) {
            // twice: a learning already running when we ask drops our leagues
            for (let i = 0; i < 2 && unlearned().size > 0; i++) await learnLeagues(unlearned());
            flush(new Map(waiting));
        }
        await writing;

        if (waiting.size > 0) {
            const leagues = [...unlearned().keys()];
            logger.warn(
                `Match crawl: ${waiting.size} match(es) not filed, read again next run` +
                    (leagues.length > 0
                        ? ` (league not learned: ${leagues.join(', ')})`
                        : ' (leaderboard of their season not loaded)'),
            );
        }

        logger.info(
            `Match crawl: ${crawlState.found} ranked matches seen, ${crawlState.inserted} new, ${crawlState.rejected} rejected, ` +
                `${crawlState.retriedPlayers} retried, ${crawlState.failedPlayers} failed, ` +
                `${crawlState.gapPlayers} gaps, ${crawlState.unsaved} unsaved, ` +
                `${crawlState.notHoM} dropped (player out of HoM), ` +
                `${crawlState.otherSeason} filed in another season`,
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
