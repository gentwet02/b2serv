import { Hono, type Context } from 'hono';
import { MATCH_SORTS, MAX_HEROES, MAX_TOWERS } from '@/config/constants';
import { crawlState, nextCrawlInMs, refreshMatchesHistory } from '@/services/matchesHistory';
import {
    canUseSameSide,
    countMatches,
    getFilterOptions,
    getStorageReport,
    queryMatches,
} from '@/services/matchStore';
import { getLiveSeason, getSeasonById } from '@/services/seasons';
import type { FacetFilter, HeroPick, MatchSort } from '@/types/match';
import { getNkClientStats } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import { scheduleEvery } from '@/utils/scheduler';

export const matchesHistory = new Hono();

const clampInt = (value: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number.parseInt(value ?? '', 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const NAME = /^[A-Za-z0-9_]{1,40}$/;

const list = (value: string | undefined, max: number) =>
    [
        ...new Set(
            (value ?? '')
                .split(',')
                .map((v) => v.trim())
                .filter((v) => NAME.test(v)),
        ),
    ].slice(0, max);

function parseHeroes(value: string | undefined): HeroPick[] {
    const picks: HeroPick[] = [];
    for (const item of (value ?? '').split(',')) {
        const [base, hero] = item.trim().split(':');
        if (!base || !NAME.test(base) || (hero && !NAME.test(hero))) continue;
        if (picks.some((p) => p.base === base)) continue;
        picks.push(hero ? { base, hero } : { base });
        if (picks.length === MAX_HEROES) break;
    }
    return picks;
}

const crawlInfo = () => ({
    isFetching: crawlState.isFetching,
    progress: crawlState.isFetching ? crawlState.progress : null,
    inserted: crawlState.inserted,
    lastRunEndedAt: crawlState.lastRunEndedAt?.toISOString() ?? null,
});

function resolveSeason(param: string | undefined) {
    return param ? getSeasonById(Number(param)) : getLiveSeason();
}

function parseFilter(c: Context, seasonId: number): FacetFilter {
    const playerId = c.req.query('playerId');
    return {
        seasonId,
        player: c.req.query('player')?.trim().slice(0, 40) || undefined,
        playerId: playerId && /^[a-z0-9]{8,64}$/i.test(playerId) ? playerId : undefined,
        heroes: parseHeroes(c.req.query('heroes')),
        towers: list(c.req.query('towers'), MAX_TOWERS),
        map: c.req.query('map')?.replace(/[^a-z0-9]/g, '') || undefined,
        sameSide: c.req.query('sameSide') === '1',
    };
}

/**
 * GET /matches-history
 *   ?season=46                     default: live season
 *   &sort=newest                   newest | oldest | longest | shortest | rounds
 *   &player=ign|alias                  part of an in-game or real name
 *   &playerId=<id>                 one player's matches (profiles)
 *   &heroes=Quincy,Adora:Adora_Fateweaver   up to 2; "Base" = any variant
 *   &towers=Druid,DartMonkey       up to 6, all of them in the match
 *   &map=thinice                   a map key from /filters
 *   &sameSide=1                    player, hero and towers on the same side
 *   &offset=0&limit=20
 */
matchesHistory.get('/', async (c) => {
    const seasonParam = c.req.query('season');
    const season = resolveSeason(seasonParam);
    if (!season) {
        const message = seasonParam
            ? `Unknown season id: ${seasonParam}`
            : 'Live season not available yet';
        return c.json({ message, error: message }, seasonParam ? 404 : 503);
    }

    const sort = c.req.query('sort') ?? '';
    const filter = {
        ...parseFilter(c, season.seasonId),
        offset: clampInt(c.req.query('offset'), 0, 0, 100_000),
        limit: clampInt(c.req.query('limit'), 20, 1, 50),
        sort: (MATCH_SORTS as readonly string[]).includes(sort) ? (sort as MatchSort) : 'newest',
    };

    try {
        const [{ total, items }, totalMatches] = await Promise.all([
            queryMatches(filter),
            countMatches(season.seasonId),
        ]);
        return c.json({
            matches: {
                seasonId: season.seasonId,
                totalMatches,
                total,
                offset: filter.offset,
                limit: filter.limit,
                sort: filter.sort,
                sameSideApplied: filter.sameSide && canUseSameSide(filter),
                items,
            },
            crawl: season.live ? crawlInfo() : null,
            message: null,
            error: null,
        });
    } catch (error) {
        logger.error(`Match query failed: ${error}`);
        const message = 'Could not read the stored matches.';
        return c.json({ message, error: message }, 500);
    }
});

matchesHistory.get('/filters', async (c) => {
    const season = resolveSeason(c.req.query('season'));
    if (!season) {
        const message = 'Unknown season';
        return c.json({ message, error: message }, 404);
    }
    try {
        const options = await getFilterOptions(parseFilter(c, season.seasonId));
        return c.json({
            seasonId: season.seasonId,
            ...options,
            sorts: MATCH_SORTS,
            maxHeroes: MAX_HEROES,
            maxTowers: MAX_TOWERS,
        });
    } catch (error) {
        logger.error(`Filter options failed: ${error}`);
        const message = 'Could not read the filter options.';
        return c.json({ message, error: message }, 500);
    }
});

matchesHistory.get('/status', async (c) =>
    c.json({
        message: 'running',
        ...crawlInfo(),
        seasonId: crawlState.seasonId,
        found: crawlState.found,
        rejected: crawlState.rejected,
        safety: {
            retriedPlayers: crawlState.retriedPlayers,
            failedPlayers: crawlState.failedPlayers,
            gapPlayers: crawlState.gapPlayers,
            unsaved: crawlState.unsaved,
        },
        lastRunStartedAt: crawlState.lastRunStartedAt?.toISOString() ?? null,
        lastError: crawlState.lastError,
        nextUpdateIn: nextCrawlInMs() ?? 'running',
        nk: getNkClientStats(),
        storage: await getStorageReport(),
        timestamp: new Date().toISOString(),
    }),
);

matchesHistory.get('/force-update', (c) => {
    if (crawlState.isFetching) return c.json({ message: 'Update already in progress' });
    void refreshMatchesHistory();
    return c.json({ message: 'Crawl started. Check /matches-history/status for progress.' }, 202);
});

export async function startMatchesScheduler() {
    void refreshMatchesHistory();
    scheduleEvery(
        'matches-history',
        async () => {
            if (nextCrawlInMs() === 0) await refreshMatchesHistory();
        },
        60_000,
    );
}
