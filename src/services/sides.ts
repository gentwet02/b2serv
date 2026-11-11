import { clanMemberIds, clanVersion, loadClanMembers } from '@/services/clanMembers';
import { getClan } from '@/services/clanStore';
import { loadCodeBook } from '@/services/codeBook';
import { storedNameOf } from '@/services/h2h';
import {
    getLeaderboardSize,
    getRankRange,
    getSeasonRank,
    readLeaderboard,
} from '@/services/leaderboard';
import {
    rangeBounds,
    resolveSeasons,
    type RangeExclude,
} from '@/services/ranges';
import { getSeasonById } from '@/services/seasons';
import type { VersusRange } from '@/types/leaderboard';
import type { NkGuildId, NkUserId } from '@/types/ninjakiwi';
import type { CompareSeason, CompareSide } from '@/types/season';

/**
 * The two sides the stats and compare pages count: who is on each side, season by season.
 * Side 1 is a player, a clan, a range of each season's leaderboard, or a list of those counted
 * together; side 2 can also be anyone. A side of several players can leave some out (`not`).
 * A clan is its known members of today in every season (services/clanMembers.ts).
 */

export type PlayerSpec = { player: NkUserId };
export type RangeSpec = { range: VersusRange; exclude: RangeExclude };
export type ClanSpec = { clan: NkGuildId };
/** One player, clan or range: a side alone, or one item of a list. */
export type PartSpec = PlayerSpec | ClanSpec | RangeSpec;
/** Several players, clans and ranges counted together as one side. */
export type ListSpec = { list: PartSpec[] };
/** The players, clans and ranges left out of a side (not of one player, nor of anyone). */
export type Excluding = { not?: PartSpec[] };
export type FirstSide = PlayerSpec | ((ClanSpec | RangeSpec | ListSpec) & Excluding);
export type SideSpec = FirstSide | { anyone: true };

export const isPlayer = (spec: SideSpec): spec is PlayerSpec => 'player' in spec;
export const isClan = (spec: SideSpec): spec is ClanSpec => 'clan' in spec;
export const isList = (spec: SideSpec): spec is ListSpec => 'list' in spec;
export const isAnyone = (spec: SideSpec): spec is { anyone: true } => 'anyone' in spec;

/** What a side is made of: its list's items, itself, or nothing (anyone). */
const partsOf = (spec: SideSpec): PartSpec[] =>
    isList(spec) ? spec.list : isAnyone(spec) ? [] : [spec];

/** What a side leaves out. */
const leftOutOf = (spec: SideSpec): PartSpec[] => ('not' in spec && spec.not) || [];

const isRange = (part: PartSpec): part is RangeSpec => 'range' in part;
/** A clan or a range read to tell who is on the side, counted or left out. */
const readsClan = (spec: SideSpec) => [...partsOf(spec), ...leftOutOf(spec)].some(isClan);
const readsRange = (spec: SideSpec) => [...partsOf(spec), ...leftOutOf(spec)].some(isRange);

/** Only players and clans, no range: few enough games to list them. */
export const isPicked = (spec: SideSpec) => !isAnyone(spec) && !partsOf(spec).some(isRange);

function partKey(spec: PartSpec) {
    if (isPlayer(spec)) return `p:${spec.player}`;
    if (isClan(spec)) return `c:${spec.clan}@${clanVersion(spec.clan)}`;
    return `${spec.range}${spec.exclude ? `-${spec.exclude}` : ''}`;
}

const partKeys = (parts: PartSpec[]) => parts.map(partKey).sort().join('+');

/**
 * "p:<id>", "c:<id>@3", "anyone", "t50-t10", "l(p:<id>+t10)", "all!(p:<id>)": a side in cache
 * keys. A clan's key changes with its members; a list's doesn't with its order.
 */
export function sideKey(spec: SideSpec): string {
    if (isAnyone(spec)) return 'anyone';
    const leftOut = leftOutOf(spec);
    const key = isList(spec) ? `l(${partKeys(spec.list)})` : partKey(spec);
    return leftOut.length ? `${key}!(${partKeys(leftOut)})` : key;
}

const NO_SIDE_INFO = {
    userId: null,
    name: null,
    alias: null,
    range: null,
    exclude: null,
    clan: null,
};

/**
 * A side for the client: its mode, the player's name, the clan, the range, or its list; and
 * who it leaves out (`not`, null: nobody).
 */
export async function describeSide(spec: SideSpec) {
    if (isAnyone(spec)) return { mode: 'anyone' as const, ...NO_SIDE_INFO, not: null };
    const leftOut = leftOutOf(spec);
    /** each one left out, as a side of its own */
    const not = leftOut.length ? await Promise.all(leftOut.map(describePart)) : null;
    if (isList(spec)) {
        return {
            mode: 'list' as const,
            ...NO_SIDE_INFO,
            /** each item, as a side of its own */
            list: await Promise.all(spec.list.map(describePart)),
            not,
        };
    }
    return { ...(await describePart(spec)), not };
}

async function describePart(spec: PartSpec) {
    const none = NO_SIDE_INFO;
    if (isClan(spec)) {
        await loadCodeBook();
        const clan = await getClan(spec.clan).catch(() => null);
        return {
            mode: 'clan' as const,
            ...none,
            /** name null: a clan we have no reading of */
            clan: {
                id: spec.clan,
                name: clan?.name ?? null,
                bannerURL: clan?.bannerURL ?? null,
            },
        };
    }
    if (isPlayer(spec)) {
        return {
            mode: 'player' as const,
            ...none,
            userId: spec.player,
            ...(await storedNameOf(spec.player)),
        };
    }
    return {
        mode: 'top' as const,
        ...none,
        range: spec.range,
        /** the range left out at the top */
        exclude: spec.exclude,
    };
}

/**
 * Both sides in each season asked for (`seasonParam`: one, "40-47" or "all"). A range, a
 * clan or a list never holds the other side's player, nor the players it leaves out. Null
 * when the season is unknown.
 */
export async function resolveSides(seasonParam: string | undefined, a: FirstSide, b: SideSpec) {
    const seasons = await resolveSeasons(seasonParam);
    if (!seasons) return null;
    if (readsClan(a) || readsClan(b)) await Promise.all([loadCodeBook(), loadClanMembers()]);

    // one season: make sure its leaderboard is loaded (ranks, ranges)
    if (seasons.length === 1) {
        const season = getSeasonById(seasons[0]!.seasonId);
        if (season) await readLeaderboard(season);
    }

    /** seasons whose leaderboard the server doesn't have yet (range sides) */
    const missing = new Set<number>();
    type Members = NonNullable<CompareSide['players']>;
    function partIn(seasonId: number, spec: PartSpec): CompareSide & { players: Members } {
        if (isPlayer(spec)) {
            return { players: [{ userId: spec.player, rank: getSeasonRank(seasonId, spec.player) }] };
        }
        if (isClan(spec)) {
            // today's members in every season, ranked or not that season
            const players = clanMemberIds(spec.clan).map((userId) => ({
                userId,
                rank: getSeasonRank(seasonId, userId),
            }));
            return { players };
        }
        const size = getLeaderboardSize(seasonId);
        if (size === null) {
            missing.add(seasonId);
            return { players: [] };
        }
        const bounds = rangeBounds(spec.range, spec.exclude, size);
        return { bounds, players: getRankRange(seasonId, bounds.from, bounds.to) ?? [] };
    }
    function sideIn(seasonId: number, spec: SideSpec, other: SideSpec): CompareSide {
        if (isAnyone(spec)) return { players: null };
        if (isPlayer(spec)) return partIn(seasonId, spec);
        // who the side leaves out that season: left out wins over counted
        const leftOut = new Set<string>(
            leftOutOf(spec).flatMap((part) => partIn(seasonId, part).players.map((p) => p.userId)),
        );
        const kept = (p: Members[number]) =>
            !leftOut.has(p.userId) && (!isPlayer(other) || p.userId !== other.player);
        if (!isList(spec)) {
            const side = partIn(seasonId, spec);
            return { ...side, players: side.players.filter(kept) };
        }
        // every item's players, each once (no ranks covered: a list isn't one block of them)
        const players = new Map<string, Members[number]>();
        for (const part of spec.list) {
            for (const p of partIn(seasonId, part).players) {
                if (kept(p) && !players.has(p.userId)) players.set(p.userId, p);
            }
        }
        return { players: [...players.values()] };
    }
    /** the size of the leaderboard a side's ranges are read from that season */
    const boardSize = (seasonId: number, spec: SideSpec) =>
        readsRange(spec) ? getLeaderboardSize(seasonId) : undefined;

    const groups: CompareSeason[] = seasons.map((season) => ({
        seasonId: season.seasonId,
        name: season.name,
        a: sideIn(season.seasonId, a, b),
        b: sideIn(season.seasonId, b, a),
    }));
    // the ranks each season covers: a range's players change with its leaderboard
    const bounds = groups
        .map((g) => [boardSize(g.seasonId, a), boardSize(g.seasonId, b)].join('/'))
        .join(',');
    return {
        seasons,
        groups,
        missing: [...missing],
        cacheKey: `${seasonParam ?? 'live'}:${sideKey(a)}|${sideKey(b)}:${bounds}`,
    };
}
