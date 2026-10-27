import { playerNames } from '@/data/playerNames';
import { CODE_BITS, loadCodeBook, nameOf, playerCodeOf, playerOf } from '@/services/codeBook';
import { getAssetUrl } from '@/services/matchMeta';
import {
    collection,
    knownHeroBases,
    listMatchSeasons,
    opposingResult,
    unpackInfo,
    unpackLoadout,
} from '@/services/matchStore';
import type { StoredMatchDoc } from '@/types/match';
import { cached } from '@/utils/cache';
import { heavy, HEAVY_QUERY_MAX_MS } from '@/utils/heavy';
import { currentMapId, heroBase, mapBaseKey, mapVariant } from '@/utils/matchLabels';

/**
 * Head to head: a player (or a group) against other players, only the games they played
 * each other. The tallies, best and worst picks and labels shared by the profile card and
 * the compare page, the profile card itself, and the list of opponents met.
 */

/** wins, losses, draws, always from the profile player's side */
export type Wld = [number, number, number];
export type WldIndex = 0 | 1 | 2;

/** A map key or a loadout key ("Quincy|Alchemist,Druid,Ninja"), with the record on it. */
export interface H2hPick {
    key: string;
    record: Wld;
}

/**
 * Like the stats: each list both ways. `maps`, `mine`, `theirs` with variants together
 * (base map, base hero), the `…Variants` ones apart ("oasis:reversed", "Quincy_Cyber|…").
 */
export interface H2hTally {
    record: Wld;
    maps: Map<string, Wld>;
    mapVariants: Map<string, Wld>;
    /** the profile player's loadouts in these games */
    mine: Map<string, Wld>;
    /** the opponent's loadouts in these games */
    theirs: Map<string, Wld>;
    /** the same loadouts with the exact hero variant ("Quincy_Cyber|…") */
    mineVariants: Map<string, Wld>;
    theirsVariants: Map<string, Wld>;
    /** last game, minutes since epoch */
    last: number;
}

export interface OpponentInput {
    userId: string;
    rank: number | null;
    /** leaderboard name, used when the server never stored a match of the player */
    name?: string | undefined;
}

/**
 * Games a map or loadout needs to be a best or a worst: any played one counts
 * (at the same win rate, the one with more games comes first).
 */
export const H2H_MIN_GAMES = { opponent: 1, total: 1 } as const;

export const RESULT_INDEX: Record<string, WldIndex> = { win: 0, lose: 1, draw: 2 };

export const newH2hTally = (): H2hTally => ({
    record: [0, 0, 0],
    maps: new Map(),
    mapVariants: new Map(),
    mine: new Map(),
    theirs: new Map(),
    mineVariants: new Map(),
    theirsVariants: new Map(),
    last: 0,
});

export function bump<K>(map: Map<K, Wld>, key: K, i: WldIndex) {
    const record = map.get(key) ?? [0, 0, 0];
    record[i]++;
    map.set(key, record);
}

export const gamesOf = (r: Wld) => r[0] + r[1] + r[2];
const rateOf = (r: Wld) => (r[0] + r[1] > 0 ? r[0] / (r[0] + r[1]) : null);

/** Best and worst win rate among the entries played at least `min` times. */
function extremes(entries: Map<string, Wld>, min: number) {
    const ok = [...entries].filter(([, r]) => gamesOf(r) >= min && rateOf(r) !== null);
    if (ok.length === 0) return { best: null, worst: null };
    const byRate = (dir: 1 | -1) => (p: [string, Wld], q: [string, Wld]) =>
        dir * (rateOf(q[1])! - rateOf(p[1])!) || gamesOf(q[1]) - gamesOf(p[1]);
    const [bestKey, bestRecord] = [...ok].sort(byRate(1))[0];
    const [worstKey, worstRecord] = [...ok].sort(byRate(-1))[0];
    const worse = rateOf(worstRecord)! < rateOf(bestRecord)!;
    return {
        best: { key: bestKey, record: bestRecord } as H2hPick,
        // one entry, or all at the same rate: no worst
        worst: worse ? ({ key: worstKey, record: worstRecord } as H2hPick) : null,
    };
}

function mostPlayed(entries: Map<string, Wld>): H2hPick | null {
    let top: H2hPick | null = null;
    for (const [key, record] of entries) {
        if (!top || gamesOf(record) > gamesOf(top.record)) top = { key, record };
    }
    return top;
}

/** Entries as a list, most played first. */
export const byGames = (entries: Map<string, Wld>, limit = Infinity): H2hPick[] =>
    [...entries]
        .map(([key, record]) => ({ key, record }))
        .sort((a, b) => gamesOf(b.record) - gamesOf(a.record))
        .slice(0, limit);

export function summarize(tally: H2hTally, min: number) {
    const maps = extremes(tally.maps, min);
    const mine = extremes(tally.mine, min);
    const theirs = extremes(tally.theirs, min);
    const mapsV = extremes(tally.mapVariants, min);
    const mineV = extremes(tally.mineVariants, min);
    const theirsV = extremes(tally.theirsVariants, min);
    return {
        record: tally.record,
        lastMet: tally.last ? new Date(tally.last * 60_000).toISOString() : null,
        maps: Object.fromEntries(tally.maps),
        mapVariants: Object.fromEntries(tally.mapVariants),
        top: {
            map: mostPlayed(tally.maps),
            mine: mostPlayed(tally.mine),
            theirs: mostPlayed(tally.theirs),
        },
        best: { map: maps.best, mine: mine.best, theirs: theirs.best },
        worst: { map: maps.worst, mine: mine.worst, theirs: theirs.worst },
        /** best and worst with variants apart (reversed maps, hero variants) */
        variants: {
            best: { map: mapsV.best, mine: mineV.best, theirs: theirsV.best },
            worst: { map: mapsV.worst, mine: mineV.worst, theirs: theirsV.worst },
        },
    };
}

/** Map and loadout keys of a set of games, and the labels / images the client needs for them. */
export function labeler() {
    const known = knownHeroBases();
    const bases = new Map<string, string>();
    const mapNames = new Map<string, string>(); // key → a raw NK id
    const heroVariants = new Map<string, string>(); // base → a raw NK id
    const rawHeroes = new Map<string, string>(); // raw NK id → base

    const baseOf = (hero: string) => {
        let base = bases.get(hero);
        if (base === undefined) {
            base = heroBase(hero, known);
            bases.set(hero, base);
        }
        return base;
    };

    return {
        /** "oasis" (both versions together), and apart: "oasis" or "oasis:reversed" (as the stats) */
        map(d: number): VariantKeys {
            const raw = unpackInfo(d).map;
            const key = mapBaseKey(raw);
            const reversed = mapVariant(raw) === 'reversed';
            const variant = reversed ? `${key}:reversed` : key;
            // the base row shows the classic map's name and image
            const classic = raw.replace(/_reversed$/, '');
            if (!mapNames.has(key) || !reversed) mapNames.set(key, classic);
            if (!mapNames.has(variant)) mapNames.set(variant, raw);
            return { key, variant };
        },
        /** "Quincy|Alchemist,Druid,Ninja", and with the exact hero: "Quincy_Cyber|…" */
        loadout(loadout: number): VariantKeys {
            const { hero, towers } = unpackLoadout(loadout);
            const base = baseOf(hero);
            if (!heroVariants.has(base) || hero === base) heroVariants.set(base, hero);
            rawHeroes.set(hero, base);
            const list = [...towers].sort().join(',');
            return { key: `${base}|${list}`, variant: `${hero}|${list}` };
        },
        async labels() {
            const maps: Record<string, { map: string; image: string | null }> = {};
            for (const [key, map] of mapNames) {
                // renamed maps show their current name
                const current = currentMapId(map);
                maps[key] = {
                    map: current,
                    image:
                        (await getAssetUrl('map', current)) ??
                        (await getAssetUrl('map', map)) ??
                        null,
                };
            }
            const heroes: Record<string, { hero: string; portrait: string | null }> = {};
            for (const [base, hero] of heroVariants) {
                heroes[base] = {
                    hero,
                    portrait:
                        (await getAssetUrl('hero', base)) ??
                        (await getAssetUrl('hero', hero)) ??
                        null,
                };
            }
            /** raw hero ("Quincy_Cyber") → base and portrait, for the variant loadouts */
            const variants: Record<string, { base: string; portrait: string | null }> = {};
            for (const [hero, base] of rawHeroes) {
                variants[hero] = {
                    base,
                    portrait: (await getAssetUrl('hero', hero)) ?? heroes[base]?.portrait ?? null,
                };
            }
            return { maps, heroes, variants };
        },
    };
}

/** Result of a stored game from the player's side, or undefined when it wasn't played. */
export function resultFor(doc: StoredMatchDoc, left: boolean): WldIndex | undefined {
    const leftResult = nameOf('result', doc.d % 2 ** CODE_BITS.result);
    return RESULT_INDEX[left ? leftResult : (opposingResult[leftResult] ?? leftResult)];
}

/** A map or loadout key with variants together, and apart. */
interface VariantKeys {
    key: string;
    variant: string;
}

/** One tally for every game of a set (maps, both loadouts, last game). */
export function count(
    tally: H2hTally,
    i: WldIndex,
    map: VariantKeys,
    mine: VariantKeys,
    theirs: VariantKeys,
    t: number,
) {
    tally.record[i]++;
    bump(tally.maps, map.key, i);
    bump(tally.mapVariants, map.variant, i);
    bump(tally.mine, mine.key, i);
    bump(tally.theirs, theirs.key, i);
    bump(tally.mineVariants, mine.variant, i);
    bump(tally.theirsVariants, theirs.variant, i);
    tally.last = Math.max(tally.last, t);
}

/** Games against any of `codes` in a season. */
async function gamesAgainst(seasonId: number, me: number, codes: number[]) {
    if (codes.length === 0) return [] as StoredMatchDoc[];
    const projection = { t: 1, a: 1, b: 1, x: 1, y: 1, d: 1 };
    // big groups (a whole leaderboard): all the player's games, filtered here
    if (codes.length > 300) {
        const wanted = new Set(codes);
        const docs = await collection(seasonId)
            .find({ $or: [{ a: me }, { b: me }] }, { projection, maxTimeMS: HEAVY_QUERY_MAX_MS })
            .toArray();
        return docs.filter((doc) => wanted.has(doc.a === me ? doc.b : doc.a));
    }
    return collection(seasonId)
        .find(
            {
                $or: [
                    { a: me, b: { $in: codes } },
                    { b: me, a: { $in: codes } },
                ],
            },
            { projection, maxTimeMS: HEAVY_QUERY_MAX_MS },
        )
        .toArray();
}

export const nameOfUser = (userId: string, fallback?: string) => {
    const code = playerCodeOf(userId);
    return (code !== undefined ? playerOf(code)?.n : undefined) ?? fallback ?? null;
};

// ---------- Profile card: 10 opponents, one row each ----------

/**
 * The profile player against each opponent. `seasonId` null = every stored season.
 * One indexed query per season; cached 5 minutes.
 */
export function headToHead(seasonId: number | null, userId: string, opponents: OpponentInput[]) {
    const key = `card:${seasonId ?? 'all'}:${userId}:${opponents.map((o) => o.userId).join(',')}`;
    return cached(key, () => heavy(() => computeHeadToHead(seasonId, userId, opponents)));
}

async function computeHeadToHead(
    seasonId: number | null,
    userId: string,
    opponents: OpponentInput[],
) {
    await loadCodeBook();
    const me = playerCodeOf(userId);
    const tallies = new Map<number, H2hTally>();
    for (const o of opponents) {
        const code = playerCodeOf(o.userId);
        if (code !== undefined && code !== me && !tallies.has(code))
            tallies.set(code, newH2hTally());
    }
    const total = newH2hTally();
    const codes = [...tallies.keys()];
    const label = labeler();

    const seasons = seasonId === null ? await listMatchSeasons() : [seasonId];
    const docs =
        me === undefined
            ? []
            : (await Promise.all(seasons.map((s) => gamesAgainst(s, me, codes)))).flat();

    for (const doc of docs) {
        const left = doc.a === me;
        const tally = tallies.get(left ? doc.b : doc.a);
        const i = resultFor(doc, left);
        if (!tally || i === undefined) continue; // cancelled / lobby disconnect: not played
        const map = label.map(doc.d);
        const mine = label.loadout(left ? doc.x : doc.y);
        const theirs = label.loadout(left ? doc.y : doc.x);
        count(tally, i, map, mine, theirs, doc.t);
        count(total, i, map, mine, theirs, doc.t);
    }

    return {
        minGames: H2H_MIN_GAMES,
        labels: await label.labels(),
        name: me !== undefined ? (playerOf(me)?.n ?? null) : null,
        alias: playerNames[userId] ?? null,
        total: summarize(total, H2H_MIN_GAMES.total),
        opponents: opponents.map((o) => {
            const code = playerCodeOf(o.userId);
            const tally = (code !== undefined && tallies.get(code)) || newH2hTally();
            return {
                userId: o.userId,
                name: nameOfUser(o.userId, o.name),
                alias: playerNames[o.userId] ?? null,
                rank: o.rank,
                ...summarize(tally, H2H_MIN_GAMES.opponent),
            };
        }),
    };
}

/** The stored name and alias of a player, for the side titles. */
export async function storedNameOf(userId: string) {
    await loadCodeBook();
    return { name: nameOfUser(userId), alias: playerNames[userId] ?? null };
}

/** Everyone the player met in these seasons, most games first (the "pick a player" list). */
export function opponentsMet(userId: string, seasonIds: number[]) {
    return cached(`met:${userId}:${seasonIds.join(',')}`, () =>
        heavy(async () => {
            await loadCodeBook();
            const me = playerCodeOf(userId);
            if (me === undefined) return [];
            const records = new Map<number, Wld>();
            for (const seasonId of seasonIds) {
                const docs = await collection(seasonId)
                    .find(
                        { $or: [{ a: me }, { b: me }] },
                        { projection: { a: 1, b: 1, d: 1 }, maxTimeMS: HEAVY_QUERY_MAX_MS },
                    )
                    .toArray();
                for (const doc of docs) {
                    const left = doc.a === me;
                    const i = resultFor(doc, left);
                    if (i !== undefined) bump(records, left ? doc.b : doc.a, i);
                }
            }
            return [...records]
                .map(([code, record]) => {
                    const player = playerOf(code);
                    return {
                        userId: player?.u ?? '',
                        name: player?.n ?? null,
                        alias: playerNames[player?.u ?? ''] ?? null,
                        record,
                    };
                })
                .filter((o) => o.userId && o.userId !== userId)
                .sort((a, b) => gamesOf(b.record) - gamesOf(a.record))
                .slice(0, 500);
        }),
    );
}

