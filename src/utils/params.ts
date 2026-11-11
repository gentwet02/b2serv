import { MAX_SIDE_PARTS } from '@/config/limits';
import { MAX_EX_HEROES, MAX_EX_MAPS, MAX_EX_TOWERS } from '@/config/matches';
import type { LoadoutFilter } from '@/services/matchStore';
import { parseExclude } from '@/services/ranges';
import type { FirstSide, PartSpec, RangeSpec, SideSpec } from '@/services/sides';
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
 * One item of a list: "p:<user id>", "c:<clan id>", "r:t50" or "r:t50-t10" (a range, one left
 * out). `everyone` false: not "all" with nobody left out (nothing is left of a side that
 * leaves everyone out); "r:all-t10" is fine.
 */
function parsePart(tag: string, everyone: boolean): PartSpec | undefined {
    const at = tag.indexOf(':');
    const kind = tag.slice(0, at);
    const value = tag.slice(at + 1);
    if (kind === 'p') return isNkUserId(value) ? { player: value } : undefined;
    if (kind === 'c') return isNkGuildId(value) ? { clan: value } : undefined;
    if (kind !== 'r') return undefined;
    const [range = '', exclude] = value.split('-');
    if (!isVersusRange(range)) return undefined;
    const part = { range, exclude: parseExclude(range, exclude) };
    return everyone || range !== 'all' || part.exclude ? part : undefined;
}

/**
 * ?list=p:<id>,c:<id>,r:t50-t10: players, clans and ranges counted together, each once, at
 * most MAX_SIDE_PARTS (?not= reads the same, without a bare "all"). Undefined without one, 'invalid'
 * for a malformed item.
 */
function parseList(value: string | undefined, everyone = true): PartSpec[] | undefined | 'invalid' {
    const tags = [...new Set((value ?? '').split(',').filter(Boolean))].slice(0, MAX_SIDE_PARTS);
    if (tags.length === 0) return undefined;
    const list: PartSpec[] = [];
    for (const tag of tags) {
        const part = parsePart(tag, everyone);
        if (!part) return 'invalid';
        list.push(part);
    }
    return list;
}

/**
 * The two sides, the same way on /stats and /compare:
 *   side 1  ?player=<id>,  ?clan=<id>,  or ?players=t25 (default) &exclude=t10
 *   side 2  &player2=<id>, &clan2=<id>, or &players2=t100 &exclude2=t25, none: against anyone
 *   several together  ?list=p:<id>,c:<id>,r:t50-t10  &list2=…
 *   left out          ?not=p:<id>,c:<id>,r:t10        &not2=…  (not of one player, nor of anyone)
 * A list goes before a player, a player before a clan, a clan before a range.
 * 'invalid' for a malformed id or list item, or the same player or clan on both sides.
 */
export function parseSides(query: Query): { a: FirstSide; b: SideSpec } | 'invalid' {
    const player = query('player');
    const player2 = query('player2');
    const clan = query('clan');
    const clan2 = query('clan2');
    const list = parseList(query('list'));
    const list2 = parseList(query('list2'));
    const not = parseList(query('not'), false);
    const not2 = parseList(query('not2'), false);
    if (
        (player !== undefined && !isNkUserId(player)) ||
        (player2 !== undefined && !isNkUserId(player2)) ||
        (clan !== undefined && !isNkGuildId(clan)) ||
        (clan2 !== undefined && !isNkGuildId(clan2)) ||
        list === 'invalid' ||
        list2 === 'invalid' ||
        not === 'invalid' ||
        not2 === 'invalid'
    ) {
        return 'invalid';
    }
    const a: FirstSide = list
        ? { list, ...(not && { not }) }
        : player
          ? { player }
          : {
                ...(clan ? { clan } : parseRange(query('players'), query('exclude'))),
                ...(not && { not }),
            };
    const b: SideSpec = list2
        ? { list: list2, ...(not2 && { not: not2 }) }
        : player2
          ? { player: player2 }
          : clan2
            ? { clan: clan2, ...(not2 && { not: not2 }) }
            : query('players2') !== undefined
              ? { ...parseRange(query('players2'), query('exclude2')), ...(not2 && { not: not2 }) }
              : { anyone: true };
    if ('player' in a && 'player' in b && a.player === b.player) return 'invalid';
    if ('clan' in a && 'clan' in b && a.clan === b.clan) return 'invalid';
    return { a, b };
}

/** &overlap=0: a player in both ranges counts only for side 1 (default: on both sides). */
export const parseOverlap = (query: Query) => query('overlap') !== '0';
