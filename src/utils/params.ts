import { MAX_EX_HEROES, MAX_EX_MAPS, MAX_EX_TOWERS } from '@/config/matches';
import type { LoadoutFilter } from '@/services/matchStore';
import { parseExclude } from '@/services/ranges';
import type { FirstSide, RangeSpec, SideSpec } from '@/services/sides';
import type { VersusRange } from '@/types/leaderboard';
import { parseMapFilter } from '@/utils/matchLabels';
import { isVersusRange } from '@/validators/leaderboard';
import { isNkGuildId, isNkUserId } from '@/validators/nk';
import { NAME_PARAM } from '@/validators/params';

/** Query parameter readers shared by the stats and compare routes. */

/** "Druid,Ninja": valid names, each once, at most `max`. */
export function nameList(value: string | undefined, max: number) {
    return [
        ...new Set(
            (value ?? '')
                .split(',')
                .map((t) => t.trim())
                .filter((t) => NAME_PARAM.test(t)),
        ),
    ].slice(0, max);
}

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
    if (!base || !NAME_PARAM.test(base)) return undefined;
    return variant && NAME_PARAM.test(variant) ? { base, hero: variant } : { base };
}

type Query = (name: string) => string | undefined;

/** ?hero=&towers=&exHeroes=&exTowers= (suffix '2': the opponent's). */
export function parseLoadoutFilter(query: Query, suffix: '' | '2' = ''): LoadoutFilter {
    return {
        hero: parseHero(query(`hero${suffix}`)),
        towers: nameList(query(`towers${suffix}`), 3),
        exHeroes: parsedList(query(`exHeroes${suffix}`), parseHero, MAX_EX_HEROES),
        exTowers: nameList(query(`exTowers${suffix}`), MAX_EX_TOWERS),
    };
}

/** ?map=oasis | oasis:classic | oasis:reversed, &exMaps=oasis,dino:reversed */
export function parseMapFocus(query: Query) {
    return {
        map: parseMapFilter(query('map')),
        exMaps: parsedList(query('exMaps'), parseMapFilter, MAX_EX_MAPS),
    };
}

/** A range of each leaderboard: ?players=t25 (default), &exclude=t10 to leave a smaller one out. */
function parseRange(range: string | undefined, exclude: string | undefined): RangeSpec {
    const value: VersusRange = range && isVersusRange(range) ? range : 't25';
    return { range: value, exclude: parseExclude(value, exclude) };
}

/**
 * The two sides, the same way on /stats and /compare:
 *   side 1  ?player=<id>,  ?clan=<id>,  or ?players=t25 (default) &exclude=t10
 *   side 2  &player2=<id>, &clan2=<id>, or &players2=t100 &exclude2=t25, none: against anyone
 * A player goes before a clan, a clan before a range.
 * 'invalid' for a malformed id, or the same player or clan on both sides.
 */
export function parseSides(query: Query): { a: FirstSide; b: SideSpec } | 'invalid' {
    const player = query('player');
    const player2 = query('player2');
    const clan = query('clan');
    const clan2 = query('clan2');
    if (
        (player !== undefined && !isNkUserId(player)) ||
        (player2 !== undefined && !isNkUserId(player2)) ||
        (clan !== undefined && !isNkGuildId(clan)) ||
        (clan2 !== undefined && !isNkGuildId(clan2))
    ) {
        return 'invalid';
    }
    if (player && player === player2) return 'invalid';
    if (!player && !player2 && clan && clan === clan2) return 'invalid';
    const a: FirstSide = player
        ? { player }
        : clan
          ? { clan }
          : parseRange(query('players'), query('exclude'));
    const b: SideSpec = player2
        ? { player: player2 }
        : clan2
          ? { clan: clan2 }
          : query('players2') !== undefined
            ? parseRange(query('players2'), query('exclude2'))
            : { anyone: true };
    return { a, b };
}

/** &overlap=0: a player in both ranges counts only for side 1 (default: on both sides). */
export const parseOverlap = (query: Query) => query('overlap') !== '0';
