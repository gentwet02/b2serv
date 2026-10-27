import { Hono, type Context } from 'hono';
import { MATCH_SORTS } from '@/config/constants';
import { runCompare, runCompareGames } from '@/services/compare';
import type { MatchSort } from '@/types/match';
import { logger } from '@/utils/logger';
import { parseLoadoutFilter, parseMapFocus, parseOverlap, parseSides } from '@/utils/params';

export const compare = new Hono();

const fail = (c: Context, message: string, status: 400 | 404 | 500) =>
    c.json({ message, error: message }, status);

/** At most this many games a page. */
const GAMES_PAGE_MAX = 50;

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
 *   &player=<id> | &players=t25&exclude=t10        side 1: one player, or a range of each leaderboard
 *   &player2=<id> | &players2=all&exclude2=t25     side 2 the same way; neither: against anyone
 *   &overlap=0                            a player in both ranges only for side 1 (default: both sides)
 *   &map &exMaps                          only the games on (or not on) these maps
 *   &hero &towers &exHeroes &exTowers     side 1's loadout, as /stats
 *   &hero2 &towers2 &exHeroes2 &exTowers2 side 2's loadout
 */
compare.get('/', async (c) => {
    const read = readQuery(c);
    if (!read) return fail(c, 'Invalid or identical players', 400);
    try {
        const data = await runCompare(c.req.query('season'), read.a, read.b, read.options);
        if (!data) return fail(c, 'Unknown season', 404);
        c.header('Cache-Control', 'public, max-age=60');
        return c.json(data);
    } catch (error) {
        logger.error(`Compare failed (${c.req.url}): ${error}`);
        return fail(c, 'Could not compute the comparison.', 500);
    }
});

/**
 * GET /compare/games: the games between the two sides, one page
 *   (the parameters of GET /compare, with a player on at least one side)
 *   &sort=newest|oldest|longest|shortest|rounds   default newest
 *   &offset=0&limit=30                            at most 50 a page
 */
compare.get('/games', async (c) => {
    const read = readQuery(c);
    if (!read) return fail(c, 'Invalid or identical players', 400);
    if (!('player' in read.a) && !('player' in read.b)) {
        return fail(c, 'The games list needs a player on one side', 400);
    }
    const sortParam = c.req.query('sort') ?? 'newest';
    const sort: MatchSort = (MATCH_SORTS as readonly string[]).includes(sortParam)
        ? (sortParam as MatchSort)
        : 'newest';
    const offset = Math.max(0, Math.floor(Number(c.req.query('offset')) || 0));
    const limit = Math.min(GAMES_PAGE_MAX, Math.max(1, Math.floor(Number(c.req.query('limit')) || 30)));
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
        logger.error(`Compare games failed (${c.req.url}): ${error}`);
        return fail(c, 'Could not list the games.', 500);
    }
});
