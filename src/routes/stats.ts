import { Hono } from 'hono';
import { MAX_EX_HEROES, MAX_EX_MAPS, MAX_EX_TOWERS } from '@/config/constants';
import { loadCodeBook, playerCodeOf } from '@/services/codeBook';
import { isEmptyLoadoutFilter, loadoutExpr, type LoadoutFilter } from '@/services/matchStore';
import { seasonScope } from '@/services/ranges';
import { describeSide, isAnyone, resolveSides, sideKey } from '@/services/sides';
import { computeStats, opponentOptions, type StatsSeasonGroup } from '@/services/stats';
import type { CompareSide } from '@/types/season';
import { logger } from '@/utils/logger';
import {
    parseLoadoutFilter,
    parseMapFocus,
    parseOverlap,
    parseSides,
} from '@/utils/params';

export const stats = new Hono();

/** Answers computed in the last 2 minutes (the cubes behind them are cached longer). */
const RESPONSE_TTL_MS = 2 * 60_000;
const responses = new Map<string, { data: unknown; expires: number }>();

/**
 * GET /stats: hero, tower, strat and map usage and win rates, from a group's side
 *   ?season=46 | 40-47 | all  default: live season
 *   &player=<id>           one player's games
 *   &players=t10|t25|t50|t100|t25p|t50p|t75p|all
 *                          or a range of each season's leaderboard (default t25);
 *   &exclude=t10           leave out a smaller range: the top 50 without the top 10
 *   &player2=<id>          only their games against one player…
 *   &players2=t100&exclude2=t25  …or against a range of each leaderboard (default: anyone)
 *   &overlap=0             a player in both ranges only for side 1 (default: on both sides)
 *   &map=oasis             a map key, both versions; oasis:classic | oasis:reversed for one
 *   &hero=Quincy           a hero base
 *   &towers=Druid,Ninja    up to 3, all in the loadout
 *   &exHeroes=Quincy,Adora  loadouts without these heroes ("Base:Variant" for one variant)
 *   &exTowers=Ninja        loadouts with none of these towers
 *   &exMaps=oasis,dino:reversed  games not on these maps (or versions)
 *   &hero2 &towers2 &exHeroes2 &exTowers2  the same on the opponent's loadout
 *   &sides=1               the sides filtered separately: also the opponents' options
 */
stats.get('/', async (c) => {
    const query = (name: string) => c.req.query(name);
    const seasonParam = c.req.query('season');
    const read = parseSides(query);
    if (read === 'invalid') {
        const message = 'Invalid or identical players';
        return c.json({ message, error: message }, 400);
    }
    const { a, b } = read;
    const overlap = parseOverlap(query);
    const { map, exMaps } = parseMapFocus(query);
    const own = parseLoadoutFilter(query);
    // the opponent's loadout (sides filtered separately)
    const theirs = parseLoadoutFilter(query, '2');
    const theirsSet = !isEmptyLoadoutFilter(theirs);
    const sidesApart = c.req.query('sides') === '1';

    const cacheKey = JSON.stringify([
        seasonParam ?? 'live',
        sideKey(a),
        sideKey(b),
        overlap,
        map,
        exMaps,
        own,
        theirsSet ? theirs : null,
        sidesApart,
    ]);
    const hit = responses.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
        c.header('Cache-Control', 'public, max-age=60');
        return c.json(hit.data as object);
    }

    try {
        await loadCodeBook();
        const sides = await resolveSides(seasonParam, a, b);
        if (!sides) {
            const message = 'Unknown season';
            return c.json({ message, error: message }, 404);
        }

        // a loadout filter as conditions on either packed loadout; false: no game can fit it
        const exprs = (f: LoadoutFilter) => {
            const onX = loadoutExpr('$x', f);
            const onY = loadoutExpr('$y', f);
            return onX === false || onY === false ? false : { onX, onY };
        };
        const opponent = theirsSet ? exprs(theirs) : null;
        const codesOf = (players: CompareSide['players']) =>
            (players ?? [])
                .map((p) => playerCodeOf(p.userId))
                .filter((code): code is number => code !== undefined);

        const groups = sides.groups.map((season) => {
            const codes = codesOf(season.a.players);
            // side 2: a player in both ranges on both sides, or side 1's only
            const mine = new Set(codes);
            const against =
                opponent === false
                    ? []
                    : season.b.players && codesOf(season.b.players).filter((code) => overlap || !mine.has(code));
            return {
                seasonId: season.seasonId,
                name: season.name,
                bounds: season.a.bounds ?? null,
                boundsAgainst: season.b.bounds ?? null,
                codes,
                against,
                opponent: opponent || null,
                groupKey: `${sides.cacheKey}:${season.seasonId}:${overlap ? 'both' : 'first'}${theirsSet ? `|opp:${JSON.stringify(theirs)}` : ''}`,
            } satisfies StatsSeasonGroup & Record<string, unknown>;
        });

        const data = await computeStats({ seasons: groups, map, exMaps, ...own });
        // the sides filtered separately: what the opponents can still be filtered on
        const ownExprs = sidesApart ? exprs(own) : null;
        const options2 = !sidesApart
            ? null
            : ownExprs === false
              ? { heroes: [], towers: [] }
              : await opponentOptions({
                    seasons: groups,
                    own: ownExprs,
                    ownKey: JSON.stringify(own),
                    map,
                    exMaps,
                    ...theirs,
                });

        const sideA = await describeSide(a);
        const body = {
            ...data,
            /** the opponents' heroes and towers (sides filtered separately) */
            options2,
            ...seasonScope(seasonParam, sides.seasons),
            mode: sideA.mode,
            /** side 1's range (one player: null) and the range it leaves out */
            players: sideA.range,
            exclude: sideA.exclude,
            band: !!sideA.exclude,
            player: sideA.userId
                ? { userId: sideA.userId, name: sideA.name, alias: sideA.alias }
                : null,
            /** who they played: null for anyone */
            against: isAnyone(b) ? null : await describeSide(b),
            /** a player in both ranges counts on both sides */
            overlap,
            /** the opponent's loadout filter */
            filters2: theirsSet ? { ...theirs, hero: theirs.hero ?? null } : null,
            filters: {
                map: map ? (map.variant ? map : { base: map.base }) : null,
                ...own,
                hero: own.hero ?? null,
                exMaps: exMaps.map((m) => (m.variant ? m : { base: m.base })),
            },
            maxExcluded: { heroes: MAX_EX_HEROES, towers: MAX_EX_TOWERS, maps: MAX_EX_MAPS },
            seasons: groups.map((g) => ({
                seasonId: g.seasonId,
                name: g.name,
                bounds: g.bounds,
                boundsAgainst: g.boundsAgainst,
                players: g.codes.length,
                /** opponents counted that season (null: anyone) */
                opponents: g.against == null ? null : g.against.length,
            })),
            /** seasons whose leaderboard the server doesn't have yet (range sides) */
            missingSeasons: sides.missing,
        };
        if (responses.size > 300) responses.clear();
        responses.set(cacheKey, { data: body, expires: Date.now() + RESPONSE_TTL_MS });
        c.header('Cache-Control', 'public, max-age=60');
        return c.json(body);
    } catch (error) {
        logger.error(`Stats failed (${cacheKey}): ${error}`);
        const message = 'Could not compute the stats.';
        return c.json({ message, error: message }, 500);
    }
});
