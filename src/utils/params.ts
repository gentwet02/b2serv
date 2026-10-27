import { MAX_EX_HEROES, MAX_EX_MAPS, MAX_EX_TOWERS } from '@/config/constants';
import type { LoadoutFilter } from '@/services/matchStore';
import { parseExclude, VERSUS_RANGES, type VersusRange } from '@/services/ranges';
import type { FirstSide, RangeSpec, SideSpec } from '@/services/sides';
import { parseMapFilter } from '@/utils/matchLabels';

/** Query parameter readers shared by the stats and compare routes. */

const NAME = /^[A-Za-z0-9_]{1,40}$/;

/** "Druid,Ninja": valid names, each once, at most `max`. */
export const nameList = (value: string | undefined, max: number) =>
    [
        ...new Set(
            (value ?? '')
                .split(',')
                .map((t) => t.trim())
                .filter((t) => NAME.test(t)),
        ),
    ].slice(0, max);

/** A comma list read item by item: the valid ones, one per base, at most `max`. */
export function parsedList<T extends { base: string }>(
    value: string | undefined,
    parse: (item: string) => T | undefined,
    max: number,
): T[] {
    const out: T[] = [];
    for (const item of (value ?? '').split(',')) {
        const parsed = parse(item.trim());
        if (!parsed || out.some((o) => o.base === parsed.base)) continue;
        out.push(parsed);
        if (out.length === max) break;
    }
    return out;
}

/** "Quincy" (any variant) or "Quincy:Quincy_Cyber". */
export function parseHero(value: string | undefined) {
    const [base, variant] = (value ?? '').split(':');
    if (!base || !NAME.test(base)) return undefined;
    return variant && NAME.test(variant) ? { base, hero: variant } : { base };
}

type Query = (name: string) => string | undefined;

/** ?hero=&towers=&exHeroes=&exTowers= (suffix '2': the opponent's). */
export const parseLoadoutFilter = (query: Query, suffix: '' | '2' = ''): LoadoutFilter => ({
    hero: parseHero(query(`hero${suffix}`)),
    towers: nameList(query(`towers${suffix}`), 3),
    exHeroes: parsedList(query(`exHeroes${suffix}`), parseHero, MAX_EX_HEROES),
    exTowers: nameList(query(`exTowers${suffix}`), MAX_EX_TOWERS),
});

/** ?map=oasis | oasis:classic | oasis:reversed, &exMaps=oasis,dino:reversed */
export const parseMapFocus = (query: Query) => ({
    map: parseMapFilter(query('map')),
    exMaps: parsedList(query('exMaps'), parseMapFilter, MAX_EX_MAPS),
});

const USER_ID = /^[a-z0-9]{8,64}$/i;

/** A range of each leaderboard: ?players=t25 (default), &exclude=t10 to leave a smaller one out. */
function parseRange(range: string | undefined, exclude: string | undefined): RangeSpec {
    const value: VersusRange = (VERSUS_RANGES as readonly string[]).includes(range ?? '')
        ? (range as VersusRange)
        : 't25';
    return { range: value, exclude: parseExclude(value, exclude) };
}

/**
 * The two sides, the same way on /stats and /compare:
 *   side 1  ?player=<id>,  or ?players=t25 (default) &exclude=t10
 *   side 2  &player2=<id>, or &players2=t100 &exclude2=t25, neither: against anyone
 * 'invalid' for a malformed id or the same player on both sides.
 */
export function parseSides(query: Query): { a: FirstSide; b: SideSpec } | 'invalid' {
    const player = query('player');
    const player2 = query('player2');
    if ((player !== undefined && !USER_ID.test(player)) || (player2 !== undefined && !USER_ID.test(player2))) {
        return 'invalid';
    }
    if (player && player === player2) return 'invalid';
    const a: FirstSide = player ? { player } : parseRange(query('players'), query('exclude'));
    const b: SideSpec = player2
        ? { player: player2 }
        : query('players2') !== undefined
          ? parseRange(query('players2'), query('exclude2'))
          : { anyone: true };
    return { a, b };
}

/** &overlap=0: a player in both ranges counts only for side 1 (default: on both sides). */
export const parseOverlap = (query: Query) => query('overlap') !== '0';
