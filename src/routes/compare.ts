import { Hono, type Context } from 'hono';
import { ERROR_MESSAGES } from '@/config/errors';
import { MAX_COMPARE_GAMES_PAGE } from '@/config/limits';
import { runCompare, runCompareGames } from '@/services/compare';
import { opponentsOfSide } from '@/services/opponents';
import { resolveSeasons } from '@/services/ranges';
import { isClan, isPlayer } from '@/services/sides';
import type { MatchSort } from '@/types/match';
import { isOverloaded } from '@/utils/heavy';
import { logger } from '@/utils/logger';
import { parseLoadoutFilter, parseMapFocus, parseOverlap, parseSides } from '@/utils/params';
import { isMatchSort } from '@/validators/match';
import { isNkGuildId, isNkUserId } from '@/validators/nk';

export const compare = new Hono();

const fail = (c: Context, message: string, status: 400 | 404 | 500) =>
    c.json({ message, error: message }, status);

/** Too much running (or a read that ran out of time): a 503 the client can retry. */
function busy(c: Context) {
    c.header('Retry-After', '10');
    return c.json({ message: ERROR_MESSAGES.BUSY, error: 'busy' }, 503);
}

/** The sides, the shared players rule and the filters, as /stats reads them. */
function readQuery(c: Context) {
    const query = (name: string) => c.req.query(name);
    const sides = parseSides(query);
    if (sides === 'invalid') return null;
    return {
        ...sides,
        options: {
            overlap: parseOverlap(query),
            filter: {
                ...parseMapFocus(query),
                own: parseLoadoutFilter(query),
                theirs: parseLoadoutFilter(query, '2'),
            },
        },
    };
}

/**
 * GET /compare: only the games between two sides, records from the first side's
 *   ?season=46 | 40-47 | all             default: live season
 *   &player=<id> | &clan=<id> | &players=t25&exclude=t10
 *                                         side 1: one player, a clan, or a range of each leaderboard
 *   &player2=<id> | &clan2=<id> | &players2=all&exclude2=t25
 *                                         side 2 the same way; none: against anyone
 *   &overlap=0                            a player in both ranges only for side 1 (default: both sides)
 *   &map &exMaps                          only the games on (or not on) these maps
 *   &hero &towers &exHeroes &exTowers     side 1's loadout, as /stats
 *   &hero2 &towers2 &exHeroes2 &exTowers2 side 2's loadout
 */
compare.get('/', async (c) => {
    const read = readQuery(c);
    if (!read) return fail(c, 'Invalid or identical sides', 400);
    try {
        const data = await runCompare(c.req.query('season'), read.a, read.b, read.options);
        if (!data) return fail(c, 'Unknown season', 404);
        c.header('Cache-Control', 'public, max-age=60');
        return c.json(data);
    } catch (error) {
        if (isOverloaded(error)) return busy(c);
        logger.error(`Compare failed (${c.req.url}): ${error}`);
        return fail(c, 'Could not compute the comparison.', 500);
    }
});

/**
 * GET /compare/games: the games between the two sides, one page
 *   (the parameters of GET /compare, with a player or a clan on at least one side)
 *   &sort=newest|oldest|longest|shortest|rounds   default newest
 *   &offset=0&limit=30                            at most 50 a page
 */
compare.get('/games', async (c) => {
    const read = readQuery(c);
    if (!read) return fail(c, 'Invalid or identical sides', 400);
    // two ranges: too many games to sort and keep
    if (![read.a, read.b].some((side) => isPlayer(side) || isClan(side))) {
        return fail(c, 'The games list needs a player or a clan on one side', 400);
    }
    const sortParam = c.req.query('sort') ?? 'newest';
    const sort: MatchSort = isMatchSort(sortParam) ? sortParam : 'newest';
    const offset = Math.max(0, Math.floor(Number(c.req.query('offset')) || 0));
    const limit = Math.min(
        MAX_COMPARE_GAMES_PAGE,
        Math.max(1, Math.floor(Number(c.req.query('limit')) || 30)),
    );
    try {
        const data = await runCompareGames(c.req.query('season'), read.a, read.b, {
            ...read.options,
            sort,
            offset,
            limit,
        });
        if (!data) return fail(c, 'Unknown season', 404);
        c.header('Cache-Control', 'public, max-age=60');
        return c.json(data);
    } catch (error) {
        if (isOverloaded(error)) return busy(c);
        logger.error(`Compare games failed (${c.req.url}): ${error}`);
        return fail(c, 'Could not list the games.', 500);
    }
});

/**
 * GET /compare/opponents: who a player or a clan met, most games first, with the record
 * against each: what the other side can be
 *   ?player=<id> | ?clan=<id>
 *   &season=46 | 40-47 | all             default: live season
 * `opponents`: the players met (at most 500); `clans`: the clans those players are in today.
 */
compare.get('/opponents', async (c) => {
    const player = c.req.query('player');
    const clan = c.req.query('clan');
    const side =
        player && isNkUserId(player)
            ? { player }
            : clan && isNkGuildId(clan)
              ? { clan }
              : null;
    if (!side) return fail(c, 'A player or a clan is needed', 400);
    const seasons = await resolveSeasons(c.req.query('season'));
    if (!seasons) return fail(c, 'Unknown season', 404);
    try {
        const data = await opponentsOfSide(
            side,
            seasons.map((s) => s.seasonId),
        );
        c.header('Cache-Control', 'public, max-age=60');
        return c.json(data);
    } catch (error) {
        if (isOverloaded(error)) return busy(c);
        logger.error(`Opponents failed (${c.req.url}): ${error}`);
        return fail(c, 'Could not list the opponents.', 500);
    }
});
