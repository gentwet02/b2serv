import mongoose from 'mongoose';
import { playerNames } from '@/data/playerNames';
import {
    CODE_BITS,
    codeOf,
    ensureCodes,
    ensurePlayers,
    findPlayerCodes,
    loadCodeBook,
    nameOf,
    namesOf,
    playerCodeOf,
    playerOf,
} from '@/services/codeBook';
import { getAssetUrl } from '@/services/matchMeta';
import type { Match, MatchPlayer } from '@/types/match';
import { extractUserId } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import { heroBase, HERO_BASES, mapKey } from '@/utils/matchLabels';

/**
 * Compact match storage: one collection per season, `matches_s<season>`, 6 small numbers per match.
 *
 *   _id  match id (hex ids stored as binary: half the bytes)
 *   t    first seen by the crawler, in minutes since 1970 (NK publishes no play date)
 *   a, b left / right player code            (codeBook player_codes)
 *   x, y left / right loadout   hero(7 bits) | tower(6) | tower(6) | tower(6)
 *   d    match info             result(3)    | map(7)   | round(7) | duration(14)
 *        duration sits in the top bits, so sorting on d sorts by duration
 *
 * Each value is range-checked before packing: nothing can spill into its neighbour.
 * Only the left player's result is stored; the right one is its opposite.
 * About 73 bytes per match, 3 small indexes.
 */

interface StoredMatchDoc {
    _id: string | mongoose.mongo.Binary;
    t: number;
    a: number;
    b: number;
    x: number;
    y: number;
    d: number;
}

const ROUND_BITS = 7;
const DURATION_BITS = 14;
const LIMIT = {
    round: 2 ** ROUND_BITS - 1, // 127
    duration: 2 ** DURATION_BITS - 1, // 16383 s, 4.5 h
};
// bit offsets
const X = { hero: 0, t1: 7, t2: 13, t3: 19 };
const D = { result: 0, map: 3, round: 10, duration: 17 };

const opposingResult: Record<string, string> = {
    win: 'lose',
    lose: 'win',
    lobbyDC: 'opponentLobbyDC',
    opponentLobbyDC: 'lobbyDC',
    draw: 'draw',
    cancelled: 'cancelled',
};

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const collectionName = (seasonId: number) => `matches_s${seasonId}`;
const collection = (seasonId: number) =>
    mongoose.connection.collection<StoredMatchDoc>(collectionName(seasonId));

const indexed = new Set<number>();
async function ensureIndexes(seasonId: number) {
    if (indexed.has(seasonId)) return;
    indexed.add(seasonId);
    try {
        await collection(seasonId).createIndexes([
            { key: { t: -1 } },
            { key: { a: 1, t: -1 } },
            { key: { b: 1, t: -1 } },
        ]);
    } catch (error) {
        indexed.delete(seasonId);
        logger.error(`Creating indexes on ${collectionName(seasonId)} failed: ${error}`);
    }
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

const HEX_ID = /^(?:[0-9a-f]{2}){4,}$/;
const packId = (id: string) =>
    HEX_ID.test(id) ? new mongoose.mongo.Binary(Buffer.from(id, 'hex')) : id;
const unpackId = (id: StoredMatchDoc['_id']) => (typeof id === 'string' ? id : id.toString('hex'));

const fits = (value: number | undefined, bits: number): value is number =>
    value !== undefined && Number.isInteger(value) && value >= 0 && value < 2 ** bits;

function packLoadout(player: MatchPlayer): number | null {
    const hero = codeOf('hero', player.hero);
    const towers = [player.towerone, player.towertwo, player.towerthree].map((t) =>
        codeOf('tower', t),
    );
    if (!fits(hero, CODE_BITS.hero) || !towers.every((t) => fits(t, CODE_BITS.tower))) return null;
    return hero + towers[0]! * 2 ** X.t1 + towers[1]! * 2 ** X.t2 + towers[2]! * 2 ** X.t3;
}

let unusualRounds = 0;

function packInfo(match: Match): number | null {
    const result = codeOf('result', match.playerLeft.result);
    const map = codeOf('map', match.map);
    const round = Math.round(match.endRound);
    const duration = Math.round(match.duration);
    if (!fits(result, CODE_BITS.result) || !fits(map, CODE_BITS.map)) return null;
    if (!(round >= 0 && round <= LIMIT.round) || !(duration >= 0 && duration <= LIMIT.duration)) {
        logger.warn(
            `Match ${match.id} skipped: round ${match.endRound} / duration ${match.duration} out of range`,
        );
        return null;
    }
    if (round > 60 && unusualRounds++ < 20) {
        logger.warn(`Match ${match.id}: end round ${round} (${match.gametype}, ${match.map})`);
    }
    return result + map * 2 ** D.map + round * 2 ** D.round + duration * 2 ** D.duration;
}

const unpackLoadout = (x: number) => ({
    hero: nameOf('hero', x % 2 ** CODE_BITS.hero),
    towers: [X.t1, X.t2, X.t3].map((shift) =>
        nameOf('tower', Math.floor(x / 2 ** shift) % 2 ** CODE_BITS.tower),
    ),
});

const unpackInfo = (d: number) => ({
    result: nameOf('result', d % 2 ** CODE_BITS.result),
    map: nameOf('map', Math.floor(d / 2 ** D.map) % 2 ** CODE_BITS.map),
    endRound: Math.floor(d / 2 ** D.round) % 2 ** ROUND_BITS,
    duration: Math.floor(d / 2 ** D.duration),
});

// the same unpacking as MongoDB expressions
const bitsOf = (field: string, shift: number, bits: number) => ({
    $mod: [shift ? { $floor: { $divide: [field, 2 ** shift] } } : field, 2 ** bits],
});
const SIDES = {
    left: { player: '$a', loadout: '$x' },
    right: { player: '$b', loadout: '$y' },
} as const;
const heroExpr = (loadout: string) => bitsOf(loadout, X.hero, CODE_BITS.hero);
const towersExpr = (loadout: string) =>
    [X.t1, X.t2, X.t3].map((s) => bitsOf(loadout, s, CODE_BITS.tower));
const mapExpr = bitsOf('$d', D.map, CODE_BITS.map);
const roundExpr = bitsOf('$d', D.round, ROUND_BITS);

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Inserts matches not stored yet; a stored match keeps its first-seen time. */
export async function saveCrawledMatches(matches: Match[], seasonId: number) {
    if (matches.length === 0) return { inserted: 0, invalid: 0 };
    await loadCodeBook();
    await ensureIndexes(seasonId);

    const sides = matches.flatMap((m) => [m.playerLeft, m.playerRight]);
    await Promise.all([
        ensureCodes(
            'hero',
            sides.map((p) => p.hero),
        ),
        ensureCodes(
            'tower',
            sides.flatMap((p) => [p.towerone, p.towertwo, p.towerthree]),
        ),
        ensureCodes(
            'map',
            matches.map((m) => m.map),
        ),
        ensureCodes(
            'result',
            matches.map((m) => m.playerLeft.result),
        ),
        ensurePlayers(sides.map((p) => [extractUserId(p.profileURL), p.displayName])),
    ]);

    const t = Math.floor(Date.now() / 60_000);
    const docs: StoredMatchDoc[] = [];
    let invalid = 0;
    for (const match of matches) {
        const a = playerCodeOf(extractUserId(match.playerLeft.profileURL));
        const b = playerCodeOf(extractUserId(match.playerRight.profileURL));
        const x = packLoadout(match.playerLeft);
        const y = packLoadout(match.playerRight);
        const d = packInfo(match);
        if (
            !match.id ||
            a === undefined ||
            b === undefined ||
            x === null ||
            y === null ||
            d === null
        ) {
            invalid++;
            continue;
        }
        docs.push({ _id: packId(match.id), t, a, b, x, y, d });
    }
    if (invalid > 0) logger.warn(`${invalid} match(es) skipped: missing data or code out of range`);
    if (docs.length === 0) return { inserted: 0, invalid };

    const result = await collection(seasonId).bulkWrite(
        docs.map((doc) => ({
            updateOne: { filter: { _id: doc._id }, update: { $setOnInsert: doc }, upsert: true },
        })),
        { ordered: false },
    );
    if (result.upsertedCount > 0) optionsCache.clear();
    return { inserted: result.upsertedCount, invalid };
}

// ---------------------------------------------------------------------------
// Reading back to NK's shape
// ---------------------------------------------------------------------------

async function side(playerCode: number, loadout: number, result: string) {
    const player = playerOf(playerCode);
    const { hero, towers } = unpackLoadout(loadout);
    const userId = player?.u ?? '';
    return {
        displayName: player?.n ?? 'Unknown player',
        realName: playerNames[userId],
        hero,
        heroPortrait: await getAssetUrl('hero', hero),
        towerone: towers[0],
        towertwo: towers[1],
        towerthree: towers[2],
        result,
        profileURL: `https://data.ninjakiwi.com/battles2/users/${userId}`,
    };
}

/** NK's match shape, plus seenAt and real names, for the client. */
export async function toApiMatch(doc: StoredMatchDoc) {
    const info = unpackInfo(doc.d);
    return {
        id: unpackId(doc._id),
        gametype: 'Ranked',
        map: info.map,
        mapURL: await getAssetUrl('map', info.map),
        endRound: info.endRound,
        duration: info.duration,
        playerLeft: await side(doc.a, doc.x, info.result),
        playerRight: await side(doc.b, doc.y, opposingResult[info.result] ?? info.result),
        seenAt: new Date(doc.t * 60_000).toISOString(),
    };
}

// ---------------------------------------------------------------------------
// Query building (shared by the match list and the filter options)
// ---------------------------------------------------------------------------

export const MATCH_SORTS = ['newest', 'oldest', 'longest', 'shortest', 'rounds'] as const;
export type MatchSort = (typeof MATCH_SORTS)[number];

/** A hero filter: any variant of `base`, or exactly `hero`. */
export interface HeroPick {
    base: string;
    hero?: string;
}

export interface MatchesFilter {
    seasonId: number;
    offset: number;
    limit: number;
    sort: MatchSort;
    player?: string; // part of a name (in-game or real)
    playerId?: string; // exact user id
    heroes: HeroPick[]; // up to 2
    towers: string[]; // up to 6
    map?: string; // map key
    /** player, hero and towers on the same side (only with ≤ 1 hero and ≤ 3 towers) */
    sameSide: boolean;
}

export type FacetFilter = Omit<MatchesFilter, 'offset' | 'limit' | 'sort'>;

export const MAX_HEROES = 2;
export const MAX_TOWERS = 6;

export function canUseSameSide(filter: Pick<MatchesFilter, 'heroes' | 'towers'>) {
    return filter.heroes.length <= 1 && filter.towers.length <= 3;
}

function knownHeroBases() {
    return new Set<string>([...HERO_BASES, ...namesOf('hero').filter((h) => !h.includes('_'))]);
}

const heroCodesFor = (pick: HeroPick) => {
    const names = pick.hero
        ? [pick.hero]
        : namesOf('hero').filter((name) => heroBase(name, knownHeroBases()) === pick.base);
    return names.map((n) => codeOf('hero', n)).filter((c): c is number => c !== undefined);
};

interface BuiltQuery {
    match: Record<string, unknown>;
    /** with "same player": which side satisfies the side conditions (aggregation expressions) */
    sideOk: [object, object] | null;
}

/** Filter → MongoDB match. null when nothing can match (unknown hero, player…). */
function buildQuery(filter: FacetFilter): BuiltQuery | null {
    const heroSets = filter.heroes.map(heroCodesFor);
    if (heroSets.some((set) => set.length === 0)) return null;

    const towerCodes = filter.towers.map((t) => codeOf('tower', t));
    if (towerCodes.some((c) => c === undefined)) return null;

    let mapCodes: number[] | null = null;
    if (filter.map) {
        mapCodes = namesOf('map')
            .filter((m) => mapKey(m) === filter.map)
            .map((m) => codeOf('map', m)!);
        if (mapCodes.length === 0) return null;
    }

    let playerCodes: number[] | null = null;
    if (filter.playerId) {
        const code = playerCodeOf(filter.playerId);
        if (code === undefined) return null;
        playerCodes = [code];
    }
    if (filter.player) {
        const found = findPlayerCodes(filter.player);
        playerCodes = playerCodes ? playerCodes.filter((c) => found.includes(c)) : found;
        if (playerCodes.length === 0) return null;
    }

    // indexed part: players
    const match: Record<string, unknown> = {};
    if (playerCodes) match.$or = [{ a: { $in: playerCodes } }, { b: { $in: playerCodes } }];

    // computed part: unpacked fields
    const exprs: object[] = [];
    if (mapCodes) exprs.push({ $in: [mapExpr, mapCodes] });

    let sideOk: BuiltQuery['sideOk'] = null;
    if (filter.sameSide && canUseSameSide(filter)) {
        const sideCondition = ({ player, loadout }: (typeof SIDES)[keyof typeof SIDES]) => {
            const all: object[] = [];
            if (playerCodes) all.push({ $in: [player, playerCodes] });
            if (heroSets[0]) all.push({ $in: [heroExpr(loadout), heroSets[0]] });
            if (towerCodes.length) all.push({ $setIsSubset: [towerCodes, towersExpr(loadout)] });
            return all.length ? { $and: all } : null;
        };
        const left = sideCondition(SIDES.left);
        const right = sideCondition(SIDES.right);
        if (left && right) {
            exprs.push({ $or: [left, right] });
            sideOk = [left, right];
        }
    } else {
        if (heroSets.length === 1) {
            exprs.push({
                $or: [
                    { $in: [heroExpr('$x'), heroSets[0]] },
                    { $in: [heroExpr('$y'), heroSets[0]] },
                ],
            });
        } else if (heroSets.length === 2) {
            // a matchup: one hero on each side
            const [h1, h2] = heroSets;
            exprs.push({
                $or: [
                    { $and: [{ $in: [heroExpr('$x'), h1] }, { $in: [heroExpr('$y'), h2] }] },
                    { $and: [{ $in: [heroExpr('$x'), h2] }, { $in: [heroExpr('$y'), h1] }] },
                ],
            });
        }
        if (towerCodes.length) {
            exprs.push({ $setIsSubset: [towerCodes, [...towersExpr('$x'), ...towersExpr('$y')]] });
        }
    }
    if (exprs.length) match.$expr = exprs.length === 1 ? exprs[0] : { $and: exprs };
    return { match, sideOk };
}

// ---------------------------------------------------------------------------
// Filter options, counted with the other selected filters applied (facets)
// ---------------------------------------------------------------------------

export interface FilterOptions {
    heroes: {
        base: string;
        count: number;
        variants: { hero: string; count: number; portrait?: string }[];
    }[];
    towers: { tower: string; count: number }[];
    maps: { key: string; map: string; count: number }[];
}

type Count = { _id: number; n: number };

const OPTIONS_TTL_MS = 60_000;
const optionsCache = new Map<string, { data: FilterOptions; expires: number }>();

async function countBy(
    seasonId: number,
    built: BuiltQuery | null,
    project: object,
): Promise<Count[]> {
    if (!built) return [];
    const pipeline: object[] = [];
    if (Object.keys(built.match).length) pipeline.push({ $match: built.match });
    pipeline.push(
        { $project: { v: project } },
        { $unwind: '$v' },
        { $group: { _id: '$v', n: { $sum: 1 } } },
    );
    return collection(seasonId).aggregate<Count>(pipeline, { allowDiskUse: true }).toArray();
}

/** Heroes (each counted once per match) on the sides that matter. */
function heroesProjection(built: BuiltQuery) {
    if (!built.sideOk) return { $setUnion: [[heroExpr('$x'), heroExpr('$y')]] };
    const [left, right] = built.sideOk;
    return {
        $setUnion: [
            { $cond: [left, [heroExpr('$x')], []] },
            { $cond: [right, [heroExpr('$y')], []] },
        ],
    };
}

/** Towers used (each counted once per match) on the sides that matter. */
function towersProjection(built: BuiltQuery) {
    if (!built.sideOk) return { $setUnion: [[...towersExpr('$x'), ...towersExpr('$y')]] };
    const [left, right] = built.sideOk;
    return {
        $setUnion: [
            { $cond: [left, towersExpr('$x'), []] },
            { $cond: [right, towersExpr('$y'), []] },
        ],
    };
}

export async function getFilterOptions(filter: FacetFilter): Promise<FilterOptions> {
    const cacheKey = JSON.stringify(filter);
    const hit = optionsCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.data;
    await loadCodeBook();
    const { seasonId } = filter;
    const known = knownHeroBases();

    const full = buildQuery(filter);
    const withoutMap = buildQuery({ ...filter, map: undefined });
    // a selected hero with a chosen variant: count its variants as if "any variant"
    const relaxed = filter.heroes.map((pick, i) =>
        pick.hero
            ? buildQuery({
                  ...filter,
                  heroes: filter.heroes.map((p, j) => (j === i ? { base: p.base } : p)),
              })
            : full,
    );

    const [mapCounts, heroCounts, towerCounts, ...relaxedHeroCounts] = await Promise.all([
        countBy(seasonId, withoutMap, [mapExpr]),
        full ? countBy(seasonId, full, heroesProjection(full)) : Promise.resolve([]),
        full ? countBy(seasonId, full, towersProjection(full)) : Promise.resolve([]),
        ...relaxed.map((built, i) =>
            filter.heroes[i].hero && built
                ? countBy(seasonId, built, heroesProjection(built))
                : Promise.resolve(null),
        ),
    ]);

    // heroes: selected bases use their relaxed counts, the others the full ones
    const byBase = new Map<string, FilterOptions['heroes'][number]>();
    const addHeroes = (counts: Count[], keep: (base: string) => boolean) => {
        for (const { _id, n } of counts) {
            const hero = nameOf('hero', _id);
            const base = heroBase(hero, known);
            if (!keep(base)) continue;
            const entry = byBase.get(base) ?? { base, count: 0, variants: [] };
            entry.count += n;
            entry.variants.push({ hero, count: n });
            byBase.set(base, entry);
        }
    };
    const selected = filter.heroes.map((p) => p.base);
    addHeroes(
        heroCounts,
        (base) => !selected.includes(base) || !filter.heroes.find((p) => p.base === base)?.hero,
    );
    filter.heroes.forEach((pick, i) => {
        const counts = relaxedHeroCounts[i];
        if (pick.hero && counts) addHeroes(counts, (base) => base === pick.base);
    });

    const byMap = new Map<string, { key: string; map: string; count: number; best: number }>();
    for (const { _id, n } of mapCounts) {
        const map = nameOf('map', _id);
        const key = mapKey(map);
        const entry = byMap.get(key) ?? { key, map, count: 0, best: -1 };
        entry.count += n;
        // show the id with the most matches (usually the current version of the map)
        if (n > entry.best) Object.assign(entry, { map, best: n });
        byMap.set(key, entry);
    }

    const heroes = await Promise.all(
        [...byBase.values()].map(async (h) => ({
            ...h,
            variants: await Promise.all(
                h.variants
                    .sort((a, b) => b.count - a.count)
                    .map(async (v) => ({ ...v, portrait: await getAssetUrl('hero', v.hero) })),
            ),
        })),
    );

    const data: FilterOptions = {
        heroes: heroes.sort((a, b) => a.base.localeCompare(b.base)),
        towers: towerCounts
            .map(({ _id, n }) => ({ tower: nameOf('tower', _id), count: n }))
            .sort((a, b) => a.tower.localeCompare(b.tower)),
        maps: [...byMap.values()]
            .map(({ key, map, count }) => ({ key, map, count }))
            .sort((a, b) => a.key.localeCompare(b.key)),
    };
    if (optionsCache.size > 500) optionsCache.clear();
    optionsCache.set(cacheKey, { data, expires: Date.now() + OPTIONS_TTL_MS });
    return data;
}

// ---------------------------------------------------------------------------
// Match list
// ---------------------------------------------------------------------------

const SORTS: Record<MatchSort, Record<string, 1 | -1>> = {
    newest: { t: -1, _id: -1 },
    oldest: { t: 1, _id: 1 },
    longest: { d: -1, t: -1 }, // duration is in the top bits of d
    shortest: { d: 1, t: -1 },
    rounds: { _round: -1, t: -1 },
};

const EMPTY = { total: 0, items: [] as Awaited<ReturnType<typeof toApiMatch>>[] };

export async function queryMatches(filter: MatchesFilter) {
    const { seasonId } = filter;
    await loadCodeBook();
    const built = buildQuery(filter);
    if (!built) return EMPTY;
    const { match } = built;

    const filtered = Object.keys(match).length > 0;
    const pipeline: object[] = [];
    if (filtered) pipeline.push({ $match: match });
    if (filter.sort === 'rounds') pipeline.push({ $addFields: { _round: roundExpr } });
    pipeline.push(
        { $sort: SORTS[filter.sort] },
        { $skip: filter.offset },
        { $limit: filter.limit },
    );

    const started = Date.now();
    const [docs, total] = await Promise.all([
        collection(seasonId).aggregate<StoredMatchDoc>(pipeline, { allowDiskUse: true }).toArray(),
        filtered
            ? collection(seasonId).countDocuments(match)
            : collection(seasonId).estimatedDocumentCount(),
    ]);
    const ms = Date.now() - started;
    if (ms > 500) logger.warn(`Slow match query (${ms}ms): ${JSON.stringify(filter)}`);

    return { total, items: await Promise.all(docs.map(toApiMatch)) };
}

// ---------------------------------------------------------------------------
// Every player's recorded games in a season (leaderboard columns)
// ---------------------------------------------------------------------------

const recordsCache = new Map<
    number,
    { data: Record<string, [number, number, number]>; expires: number }
>();

/** userId → [wins, losses, draws] from the stored matches. Cached 5 minutes. */
export async function getSeasonRecords(seasonId: number) {
    const hit = recordsCache.get(seasonId);
    if (hit && hit.expires > Date.now()) return hit.data;
    await loadCodeBook();

    const code = (name: string) => codeOf('result', name) ?? -1;
    const [WIN, LOSE, DRAW] = [code('win'), code('lose'), code('draw')];
    const is = (value: number) => ({ $cond: [{ $eq: ['$r', value] }, 1, 0] });

    const rows = await collection(seasonId)
        .aggregate<{ _id: number; w: number; l: number; d: number }>(
            [
                { $project: { a: 1, b: 1, r: { $mod: ['$d', 2 ** CODE_BITS.result] } } },
                {
                    $project: {
                        s: [
                            { p: '$a', w: is(WIN), l: is(LOSE), d: is(DRAW) },
                            // the right player's result is the opposite of the left one
                            { p: '$b', w: is(LOSE), l: is(WIN), d: is(DRAW) },
                        ],
                    },
                },
                { $unwind: '$s' },
                {
                    $group: {
                        _id: '$s.p',
                        w: { $sum: '$s.w' },
                        l: { $sum: '$s.l' },
                        d: { $sum: '$s.d' },
                    },
                },
            ],
            { allowDiskUse: true },
        )
        .toArray();

    const data: Record<string, [number, number, number]> = {};
    for (const row of rows) {
        const player = playerOf(row._id);
        if (player) data[player.u] = [row.w, row.l, row.d];
    }
    recordsCache.set(seasonId, { data, expires: Date.now() + 5 * 60_000 });
    return data;
}

export async function countMatches(seasonId: number) {
    return collection(seasonId).estimatedDocumentCount();
}

/** One player's stored matches, newest first. */
export async function getMatchesOfPlayer(userId: string, seasonId: number) {
    await loadCodeBook();
    const code = playerCodeOf(userId);
    if (code === undefined) return [];
    const docs = await collection(seasonId)
        .find({ $or: [{ a: code }, { b: code }] })
        .sort({ t: -1 })
        .toArray();
    return Promise.all(docs.map(toApiMatch));
}

export async function getStoredMatch(id: string, seasonId: number) {
    await loadCodeBook();
    const doc = await collection(seasonId).findOne({ _id: packId(id) });
    return doc ? toApiMatch(doc) : null;
}

export async function getAllStoredMatches(seasonId: number) {
    await loadCodeBook();
    const docs = await collection(seasonId).find({}).sort({ t: -1 }).toArray();
    return Promise.all(docs.map(toApiMatch));
}

// ---------------------------------------------------------------------------
// One player's season, from the stored matches
// ---------------------------------------------------------------------------

export async function getSeasonStats(userId: string, seasonId: number) {
    await loadCodeBook();
    const code = playerCodeOf(userId);
    const docs =
        code === undefined
            ? []
            : await collection(seasonId)
                  .find(
                      { $or: [{ a: code }, { b: code }] },
                      { projection: { t: 1, a: 1, x: 1, y: 1, d: 1 } },
                  )
                  .sort({ t: 1 })
                  .toArray();

    let wins = 0;
    let losses = 0;
    let draws = 0;
    let other = 0;
    let streak = 0;
    let bestStreak = 0;
    const heroes = new Map<string, { hero: string; played: number; wins: number }>();

    for (const doc of docs) {
        const left = doc.a === code;
        const leftResult = nameOf('result', doc.d % 2 ** CODE_BITS.result);
        const result = left ? leftResult : (opposingResult[leftResult] ?? leftResult);
        const heroName = nameOf('hero', (left ? doc.x : doc.y) % 2 ** CODE_BITS.hero);
        const hero = heroes.get(heroName) ?? { hero: heroName, played: 0, wins: 0 };

        if (result === 'win') {
            wins++;
            streak++;
            bestStreak = Math.max(bestStreak, streak);
            hero.played++;
            hero.wins++;
        } else if (result === 'lose' || result === 'draw') {
            if (result === 'lose') losses++;
            else draws++;
            streak = 0;
            hero.played++;
        } else {
            other++; // cancelled or lobby disconnect: not a played game
        }
        heroes.set(heroName, hero);
    }

    const minutes = (t?: number) => (t === undefined ? null : new Date(t * 60_000).toISOString());
    return {
        seasonId,
        recorded: docs.length,
        wins,
        losses,
        draws,
        other,
        winStreak: streak,
        bestWinStreak: bestStreak,
        heroes: await Promise.all(
            [...heroes.values()]
                .filter((h) => h.played > 0)
                .sort((a, b) => b.played - a.played)
                .slice(0, 3)
                .map(async (h) => ({ ...h, portrait: await getAssetUrl('hero', h.hero) })),
        ),
        firstSeen: minutes(docs[0]?.t),
        lastSeen: minutes(docs.at(-1)?.t),
    };
}

// ---------------------------------------------------------------------------
// Storage report (Atlas free tier: 512 MB)
// ---------------------------------------------------------------------------

export async function getStorageReport() {
    const db = mongoose.connection.db;
    if (!db) return null;
    const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 100) / 100;
    try {
        const stats = await db.stats();
        const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(
            (c) => c.name,
        );
        const matchCollections = await Promise.all(
            names
                .filter((n) => /^matches_s\d+$/.test(n))
                .map(async (name) => ({
                    name,
                    matches: await db.collection(name).estimatedDocumentCount(),
                })),
        );
        return {
            dataMB: mb(stats.dataSize),
            indexMB: mb(stats.indexSize),
            storageMB: mb(stats.storageSize),
            totalMB: mb(stats.dataSize + stats.indexSize),
            limitMB: 512,
            seasons: matchCollections.sort((a, b) => a.name.localeCompare(b.name)),
        };
    } catch (error) {
        logger.error(`Storage report failed: ${error}`);
        return null;
    }
}
