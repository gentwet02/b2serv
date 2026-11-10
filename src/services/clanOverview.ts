import { CLAN_H2H_OPPONENTS, HEAVY_QUERY_MAX_MS } from '@/config/limits';
import { clanIdOfPlayer, clanMemberCodes, clanVersion } from '@/services/clanMembers';
import { rankClans, type RankedClan } from '@/services/clanRanking';
import { clanLabels } from '@/services/clanStore';
import { playerOf } from '@/services/codeBook';
import {
    bump,
    extremes,
    gamesOf,
    mostPlayed,
    resultFor,
    type H2hPick,
    type Wld,
} from '@/services/h2h';
import { collection, listMatchSeasons } from '@/services/matchStore';
import { getLifetimeRecords } from '@/services/profileStore';
import { getLiveSeason } from '@/services/seasons';
import type { NkGuildId } from '@/types/ninjakiwi';
import { cached } from '@/utils/cache';
import { heavy } from '@/utils/heavy';
import { aliasOf, tagOf } from '@/utils/players';

/**
 * A clan's page: its known members' games added up. This season and season by season from
 * the matches we recorded: one read of the members' games per season gives the record, each
 * member's, and the record against each other clan (the clan the opponent is in today); a
 * game between two members counts for both, like a group's on the stats page.
 * All time from NK's lifetime numbers in the members' stored profiles, as on a profile; only
 * the rival clans there come from the recorded matches.
 */

/** The games of one scope (the live season, or every season). */
interface Tally {
    record: Wld;
    /** player code → record, last game (minutes) */
    players: Map<string, Wld>;
    playersLast: Map<string, number>;
    /** clan id → record against it, last game */
    rivals: Map<string, Wld>;
    rivalsLast: Map<string, number>;
    last: number;
}

function newTally(): Tally {
    return {
        record: [0, 0, 0],
        players: new Map(),
        playersLast: new Map(),
        rivals: new Map(),
        rivalsLast: new Map(),
        last: 0,
    };
}

const iso = (t: number | undefined) => (t ? new Date(t * 60_000).toISOString() : null);
const latest = (map: Map<string, number>, key: string, t: number) =>
    map.set(key, Math.max(map.get(key) ?? 0, t));

/** A member picked out of a tally: who they are, and their record. */
function memberPick(pick: H2hPick | null) {
    const player = pick && playerOf(Number(pick.key));
    if (!pick || !player) return null;
    return {
        userId: player.u,
        name: player.n,
        alias: aliasOf(player.u) ?? null,
        tag: tagOf(player.u) ?? null,
        record: pick.record,
    };
}

async function computeOverview(clanId: NkGuildId, top: RankedClan[]) {
    const codes = clanMemberCodes(clanId);
    const mine = new Set(codes);
    const live = getLiveSeason();
    const season = newTally();
    const all = newTally();
    const seasons: { seasonId: number; wins: number; draws: number; losses: number }[] = [];

    for (const seasonId of codes.length > 0 ? await listMatchSeasons() : []) {
        const record: Wld = [0, 0, 0];
        const tallies = seasonId === live?.seasonId ? [all, season] : [all];
        const cursor = collection(seasonId).find(
            { $or: [{ a: { $in: codes } }, { b: { $in: codes } }] },
            {
                projection: { t: 1, a: 1, b: 1, d: 1 },
                maxTimeMS: HEAVY_QUERY_MAX_MS,
                // small batches: see compare.ts
                batchSize: 2000,
            },
        );
        for await (const doc of cursor) {
            for (const left of [true, false]) {
                const me = left ? doc.a : doc.b;
                if (!mine.has(me)) continue;
                const i = resultFor(doc, left);
                if (i === undefined) continue; // cancelled / lobby disconnect: not played
                record[i]++;
                const rival = clanIdOfPlayer(left ? doc.b : doc.a);
                for (const tally of tallies) {
                    tally.record[i]++;
                    tally.last = Math.max(tally.last, doc.t);
                    bump(tally.players, String(me), i);
                    latest(tally.playersLast, String(me), doc.t);
                    if (rival && rival !== clanId) {
                        bump(tally.rivals, rival, i);
                        latest(tally.rivalsLast, rival, doc.t);
                    }
                }
            }
        }
        if (gamesOf(record) > 0) {
            seasons.push({ seasonId, wins: record[0], draws: record[2], losses: record[1] });
        }
    }

    // the clans we can name: the ones with a reading
    const labels = await clanLabels([...all.rivals.keys()]);

    // NK's lifetime ranked numbers of each member, from their stored profile
    const lifetime = new Map<string, Wld>();
    const lifetimeTotal: Wld = [0, 0, 0];
    for (const [code, record] of await getLifetimeRecords(codes)) {
        if (gamesOf(record) === 0) continue;
        lifetime.set(String(code), record);
        record.forEach((n, i) => (lifetimeTotal[i]! += n));
    }

    /** `record` and `players`: the games counted; the rival clans: always the recorded ones. */
    function summary(record: Wld, players: Map<string, Wld>, tally: Tally) {
        const rivals = new Map([...tally.rivals].filter(([id]) => labels.has(id)));
        function rival(pick: H2hPick | null) {
            return (
                pick && {
                    clan: { id: pick.key, name: labels.get(pick.key)!.name },
                    record: pick.record,
                }
            );
        }
        return {
            record,
            lastGame: iso(tally.last),
            /** members with a game */
            players: players.size,
            mostActive: memberPick(mostPlayed(players)),
            /** by win rate, shrunk toward the clan's when they played little (h2h.extremes) */
            best: memberPick(extremes(players, 1, record).best),
            /** the clan they met the most, and the one that beats them the most surely */
            rivals: {
                mostPlayed: rival(mostPlayed(rivals)),
                toughest: rival(extremes(rivals, 1, tally.record).worst),
            },
        };
    }

    /** The record against each of the top clans, met or not. */
    function against(tally: Tally) {
        return top.map((c) => ({
            clan: { id: c.id, name: c.name, bannerURL: c.bannerURL, known: c.known },
            record: tally.rivals.get(c.id) ?? ([0, 0, 0] as Wld),
            lastMet: iso(tally.rivalsLast.get(c.id)),
        }));
    }

    return {
        /** the live season (null before the server knows it) */
        season: live && {
            seasonId: live.seasonId,
            name: live.name,
            ...summary(season.record, season.players, season),
        },
        /** NK's lifetime numbers (the rival clans: from the recorded matches) */
        allTime: summary(lifetimeTotal, lifetime, all),
        /** newest first, the seasons with a game */
        seasons: seasons.reverse(),
        /** against the top clans (clanRanking.ts) */
        headToHead: { season: against(season), all: against(all) },
        /** each member with a game: their record this season and in every season */
        members: [...all.players].flatMap(([key, record]) => {
            const userId = playerOf(Number(key))?.u;
            if (!userId) return [];
            return {
                userId,
                season: season.players.get(key) ?? ([0, 0, 0] as Wld),
                all: record,
                lastGame: iso(all.playersLast.get(key)),
            };
        }),
    };
}

/**
 * The clan's overview, cached 5 minutes. Needs loadClanMembers and the code book loaded (the
 * cache key holds the members' version).
 */
export async function clanOverview(clanId: NkGuildId) {
    // before the heavy read: the ranking is one of its own
    const top = (await rankClans()).filter((c) => c.id !== clanId).slice(0, CLAN_H2H_OPPONENTS);
    return cached(`clan-overview:${clanId}@${clanVersion(clanId)}`, () =>
        heavy(() => computeOverview(clanId, top)),
    );
}
