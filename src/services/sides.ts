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
    type VersusRange,
} from '@/services/ranges';
import { getSeasonById } from '@/services/seasons';
import type { CompareSeason, CompareSide } from '@/types/season';

/**
 * The two sides the stats and compare pages count: who is on each side, season by season.
 * Side 1 is a player or a range of each season's leaderboard; side 2 can also be anyone.
 */

export type RangeSpec = { range: VersusRange; exclude: RangeExclude };
export type FirstSide = { player: string } | RangeSpec;
export type SideSpec = FirstSide | { anyone: true };

export const isPlayer = (spec: SideSpec): spec is { player: string } => 'player' in spec;
export const isAnyone = (spec: SideSpec): spec is { anyone: true } => 'anyone' in spec;

/** "p:<id>", "anyone", "t50-t10": a side in cache keys. */
export const sideKey = (spec: SideSpec) =>
    isPlayer(spec)
        ? `p:${spec.player}`
        : isAnyone(spec)
          ? 'anyone'
          : `${spec.range}${spec.exclude ? `-${spec.exclude}` : ''}`;

/** A side for the client: its mode, the player's name, or the range. */
export async function describeSide(spec: SideSpec) {
    const none = { userId: null, name: null, alias: null, range: null, exclude: null };
    if (isAnyone(spec)) return { mode: 'anyone' as const, ...none };
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
 * Both sides in each season asked for (`seasonParam`: one, "40-47" or "all"). A range never
 * holds the other side's player. Null when the season is unknown.
 */
export async function resolveSides(seasonParam: string | undefined, a: FirstSide, b: SideSpec) {
    const seasons = await resolveSeasons(seasonParam);
    if (!seasons) return null;

    // one season: make sure its leaderboard is loaded (ranks, ranges)
    if (seasons.length === 1) {
        const season = getSeasonById(seasons[0]!.seasonId);
        if (season) await readLeaderboard(season);
    }

    /** seasons whose leaderboard the server doesn't have yet (range sides) */
    const missing = new Set<number>();
    const sideIn = (seasonId: number, spec: SideSpec, other: SideSpec): CompareSide => {
        if (isPlayer(spec)) {
            return { players: [{ userId: spec.player, rank: getSeasonRank(seasonId, spec.player) }] };
        }
        if (isAnyone(spec)) return { players: null };
        const size = getLeaderboardSize(seasonId);
        if (size === null) {
            missing.add(seasonId);
            return { players: [] };
        }
        const bounds = rangeBounds(spec.range, spec.exclude, size);
        const players = (getRankRange(seasonId, bounds.from, bounds.to) ?? []).filter(
            (p) => !isPlayer(other) || p.userId !== other.player,
        );
        return { bounds, players };
    };

    const groups: CompareSeason[] = seasons.map((season) => ({
        seasonId: season.seasonId,
        name: season.name,
        a: sideIn(season.seasonId, a, b),
        b: sideIn(season.seasonId, b, a),
    }));
    // the ranks each season covers: a range's players change with its leaderboard
    const bounds = groups.map((g) => [g.a.bounds?.size, g.b.bounds?.size].join('/')).join(',');
    return {
        seasons,
        groups,
        missing: [...missing],
        cacheKey: `${seasonParam ?? 'live'}:${sideKey(a)}|${sideKey(b)}:${bounds}`,
    };
}
