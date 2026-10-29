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
 * (few games are handled by the shrunk score of `extremes`).
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

/** Bounds of the prior strength K of `extremes`, in games. */
export const H2H_PRIOR = { min: 5, share: 1 / 5, fallbackMax: 100 } as const;

/**
 * Prior strength K, in games, for a set of entries (empirical Bayes, beta-binomial moments):
 * how much the entries' win rates really differ, once the luck of their sample sizes is removed.
 * Entries that truly differ a lot → small K (trust each record); all about the same → large K
 * (a hot streak on a few games is luck). Works from 1 game to millions: K is measured, not guessed.
 * Kept between `min` and a fifth of the games; with under 3 entries there is no spread to
 * measure, so a fifth of the games capped at `fallbackMax`.
 */
function priorGames(entries: Wld[]): number {
    const decided = entries.map((r) => r[0] + r[1]).filter((n) => n > 0);
    const games = decided.reduce((a, n) => a + n, 0);
    const max = Math.max(H2H_PRIOR.min, games * H2H_PRIOR.share);
    if (decided.length < 3) return Math.min(H2H_PRIOR.fallbackMax, max);
    const wins = entries.reduce((a, r) => a + r[0], 0);
    const mu = wins / games;
    const bernoulli = mu * (1 - mu);
    // spread of the observed rates, weighted by games, minus what the sample sizes alone explain
    let spread = 0;
    for (const r of entries) {
        const n = r[0] + r[1];
        if (n > 0) spread += n * (r[0] / n - mu) ** 2;
    }
    const trueSpread = spread / games - (bernoulli * decided.length) / games;
    const K = trueSpread > 1e-9 ? bernoulli / trueSpread : max;
    return Math.min(max, Math.max(H2H_PRIOR.min, K));
}

/**
 * Best and worst among the entries played at least `min` times, by win rate shrunk toward the
 * overall rate (Bayesian average): (wins + K·p) / (wins + losses + K), K from `priorGames`.
 * With few games an entry stays near the average, so a 1–0 doesn't beat a 40–10; with many,
 * its own rate dominates. Draws don't count. At the same score, the one with more games first.
 * A best needs at least one win, a worst at least one loss.
 */
function extremes(entries: Map<string, Wld>, min: number, overall: Wld) {
    const K = priorGames([...entries.values()]);
    // overall rate, itself pulled a bit toward 50% so a 3–0 total doesn't pin every score at 100%
    const prior = (overall[0] + 1) / (overall[0] + overall[1] + 2);
    const scoreOf = (r: Wld) => (r[0] + K * prior) / (r[0] + r[1] + K);
    const ok = [...entries]
        .filter(([, r]) => gamesOf(r) >= min && r[0] + r[1] > 0)
        .map(([key, record]) => ({ key, record, score: scoreOf(record) }));
    if (ok.length === 0) return { best: null, worst: null };
    const byScore = (dir: 1 | -1) => (p: (typeof ok)[number], q: (typeof ok)[number]) =>
        dir * (q.score - p.score) || gamesOf(q.record) - gamesOf(p.record);
    // a best needs a win and a worst a loss: never a 0% best or a 100% worst
    const best = ok.filter((e) => e.record[0] > 0).sort(byScore(1))[0];
    const worst = ok.filter((e) => e.record[1] > 0).sort(byScore(-1))[0];
    const pick = (e: (typeof ok)[number] | undefined) =>
        e ? ({ key: e.key, record: e.record } as H2hPick) : null;
    return {
        best: pick(best),
        // the same entry, or all at the same score: no worst
        worst: worst && (!best || worst.score < best.score) ? pick(worst) : null,
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
    const maps = extremes(tally.maps, min, tally.record);
    const mine = extremes(tally.mine, min, tally.record);
    const theirs = extremes(tally.theirs, min, tally.record);
    const mapsV = extremes(tally.mapVariants, min, tally.record);
    const mineV = extremes(tally.mineVariants, min, tally.record);
    const theirsV = extremes(tally.theirsVariants, min, tally.record);
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
