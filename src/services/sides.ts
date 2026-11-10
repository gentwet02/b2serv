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
 * Side 1 is a player, a clan or a range of each season's leaderboard; side 2 can also be
 * anyone. A clan is its known members of today in every season (services/clanMembers.ts).
 */

export type RangeSpec = { range: VersusRange; exclude: RangeExclude };
export type ClanSpec = { clan: NkGuildId };
export type FirstSide = { player: NkUserId } | ClanSpec | RangeSpec;
export type SideSpec = FirstSide | { anyone: true };

export const isPlayer = (spec: SideSpec): spec is { player: NkUserId } => 'player' in spec;
export const isClan = (spec: SideSpec): spec is ClanSpec => 'clan' in spec;
export const isAnyone = (spec: SideSpec): spec is { anyone: true } => 'anyone' in spec;

/**
 * "p:<id>", "c:<id>@3", "anyone", "t50-t10": a side in cache keys. A clan's key changes with
 * its members.
 */
export function sideKey(spec: SideSpec) {
    if (isPlayer(spec)) return `p:${spec.player}`;
    if (isClan(spec)) return `c:${spec.clan}@${clanVersion(spec.clan)}`;
    if (isAnyone(spec)) return 'anyone';
    return `${spec.range}${spec.exclude ? `-${spec.exclude}` : ''}`;
}

/** A side for the client: its mode, the player's name, the clan, or the range. */
export async function describeSide(spec: SideSpec) {
    const none = {
        userId: null,
        name: null,
        alias: null,
        range: null,
        exclude: null,
        clan: null,
    };
    if (isAnyone(spec)) return { mode: 'anyone' as const, ...none };
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
 * Both sides in each season asked for (`seasonParam`: one, "40-47" or "all"). A range or a
 * clan never holds the other side's player. Null when the season is unknown.
 */
export async function resolveSides(seasonParam: string | undefined, a: FirstSide, b: SideSpec) {
    const seasons = await resolveSeasons(seasonParam);
    if (!seasons) return null;
    if (isClan(a) || isClan(b)) await Promise.all([loadCodeBook(), loadClanMembers()]);

    // one season: make sure its leaderboard is loaded (ranks, ranges)
    if (seasons.length === 1) {
        const season = getSeasonById(seasons[0]!.seasonId);
        if (season) await readLeaderboard(season);
    }

    /** seasons whose leaderboard the server doesn't have yet (range sides) */
    const missing = new Set<number>();
    function sideIn(seasonId: number, spec: SideSpec, other: SideSpec): CompareSide {
        if (isPlayer(spec)) {
            return { players: [{ userId: spec.player, rank: getSeasonRank(seasonId, spec.player) }] };
        }
        if (isAnyone(spec)) return { players: null };
        if (isClan(spec)) {
            // today's members in every season, ranked or not that season
            const players = clanMemberIds(spec.clan)
                .filter((userId) => !isPlayer(other) || userId !== other.player)
                .map((userId) => ({ userId, rank: getSeasonRank(seasonId, userId) }));
            return { players };
        }
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
    }

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
