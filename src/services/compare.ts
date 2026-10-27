import { playerNames } from '@/data/playerNames';
import { loadCodeBook, playerCodeOf } from '@/services/codeBook';
import {
    byGames,
    count,
    gamesOf,
    H2H_MIN_GAMES,
    labeler,
    newH2hTally,
    resultFor,
    nameOfUser,
    summarize,
    type Wld,
} from '@/services/h2h';
import {
    collection,
    isEmptyLoadoutFilter,
    knownHeroBases,
    toApiMatch,
    unpackInfo,
    unpackLoadout,
    type LoadoutFilter,
} from '@/services/matchStore';
import { seasonScope } from '@/services/ranges';
import { describeSide, resolveSides, type FirstSide, type SideSpec } from '@/services/sides';
import type { HeroPick, MatchSort, StoredMatchDoc } from '@/types/match';
import type { CompareSeason, CompareSide } from '@/types/season';
import { cached, createCache } from '@/utils/cache';
import { heavy, HEAVY_QUERY_MAX_MS } from '@/utils/heavy';
import { heroBase, mapFits, type MapVariant } from '@/utils/matchLabels';

/**
 * The compare side of the stats page: the games between two sides (a player or a range of
 * each leaderboard, side 2 also anyone), with the record, best and worst picks and each
 * player's record (`runCompare`), or the games themselves, sorted and paged (`runCompareGames`).
 * A player in both ranges counts for side 1, or on both sides with `overlap` (a game
 * between two of them then counts once from each side).
 */

/** Loadouts sent per side, most played first. */
const COMPARE_LOADOUTS = 60;

/** Map and loadout filters on the games between the sides (side 1's loadout, side 2's). */
export interface GameFilter {
    map?: { base: string; variant?: MapVariant | undefined } | undefined;
    exMaps: { base: string; variant?: MapVariant | undefined }[];
    own: LoadoutFilter;
    theirs: LoadoutFilter;
}

export const isEmptyGameFilter = (f: GameFilter | undefined) =>
    !f ||
    (!f.map && f.exMaps.length === 0 && isEmptyLoadoutFilter(f.own) && isEmptyLoadoutFilter(f.theirs));

/** The filter as plain checks on a stored game (decoded once per map and loadout). */
function gameChecks(filter: GameFilter) {
    const known = knownHeroBases();
    const maps = new Map<string, boolean>(); // raw map name → fits
    const loadouts = [new Map<number, boolean>(), new Map<number, boolean>()];
    const fits = (packed: number, f: LoadoutFilter) => {
        const { hero, towers } = unpackLoadout(packed);
        const base = heroBase(hero, known);
        const isHero = (h: HeroPick) => h.base === base && (!h.hero || h.hero === hero);
        return (
            (!f.hero || isHero(f.hero)) &&
            !f.exHeroes.some(isHero) &&
            f.towers.every((t) => towers.includes(t)) &&
            !f.exTowers.some((t) => towers.includes(t))
        );
    };
    const cachedFit = (cache: Map<number, boolean>, packed: number, f: LoadoutFilter) => {
        let ok = cache.get(packed);
        if (ok === undefined) cache.set(packed, (ok = fits(packed, f)));
        return ok;
    };
    return {
        map(d: number) {
            const raw = unpackInfo(d).map;
            let ok = maps.get(raw);
            if (ok === undefined) {
                ok =
                    (!filter.map || mapFits(raw, filter.map)) &&
                    !filter.exMaps.some((m) => mapFits(raw, m));
                maps.set(raw, ok);
            }
            return ok;
        },
        own: (packed: number) => cachedFit(loadouts[0]!, packed, filter.own),
        theirs: (packed: number) => cachedFit(loadouts[1]!, packed, filter.theirs),
    };
}

/** Each side's players as codes in a season (a range without the shared players, unless `overlap`). */
function seasonCodes(season: CompareSeason, overlap: boolean) {
    const codesOf = (players: CompareSide['players'], skip?: Set<number>) => {
        const codes = new Map<number, string>(); // code → user id
        for (const p of players ?? []) {
            const code = playerCodeOf(p.userId);
            if (code !== undefined && !skip?.has(code)) codes.set(code, p.userId);
        }
        return codes;
    };
    const a = codesOf(season.a.players);
    // side 2 null: anyone
    const b = season.b.players && codesOf(season.b.players, overlap ? undefined : new Set(a.keys()));
    return { a, b };
}

/**
 * The places side 1 has in a game, as `left` (side 1 on a): one, or both when the two
 * players are on both sides; none when the game isn't between the sides.
 */
function sidesOf(doc: StoredMatchDoc, a: Map<number, unknown>, b: Map<number, unknown> | null) {
    const out: boolean[] = [];
    if (a.has(doc.a) && (!b || b.has(doc.b))) out.push(true);
    if (a.has(doc.b) && (!b || b.has(doc.a))) out.push(false);
    return out;
}

/** Past this many players on a side, its codes aren't sent to MongoDB (see eachGameBetween). */
const BIG_SIDE = 300;

/**
 * The games of two sets of player codes in a season (`b` null: anyone), streamed. The caller
 * keeps only the games between the sides (`sidesOf`): against a big side (a whole
 * leaderboard), only the small side's games are read, on the index, and sorted out here,
 * rather than an $in of thousands of codes MongoDB would walk the index for.
 */
async function eachGameBetween(
    seasonId: number,
    a: number[],
    b: number[] | null,
    visit: (doc: StoredMatchDoc) => void,
) {
    if (a.length === 0 || b?.length === 0) return;
    const any = (codes: number[]) => (codes.length === 1 ? codes[0] : { $in: codes });
    // only when one side is small: two big sides (whole leaderboards) keep the exact query
    const [smaller, bigger] = b && a.length <= b.length ? [a, b] : [b ?? a, a];
    const small = b && smaller.length <= BIG_SIDE && bigger.length > BIG_SIDE ? smaller : null;
    const filter = small
        ? { $or: [{ a: any(small) }, { b: any(small) }] }
        : b
          ? { $or: [{ a: any(a), b: any(b) }, { a: any(b), b: any(a) }] }
          : { $or: [{ a: any(a) }, { b: any(a) }] };
    const cursor = collection(seasonId).find(filter, {
        projection: { t: 1, a: 1, b: 1, x: 1, y: 1, d: 1 },
        maxTimeMS: HEAVY_QUERY_MAX_MS,
        // small batches: a 16 MB batch is ~200k games turned into objects at once (1 GB VM)
        batchSize: 2000,
    });
    for await (const doc of cursor) visit(doc as StoredMatchDoc);
}

/** A game seen from side 1 (`left`: on a) fits the filters, and was played. */
function playable(checks: ReturnType<typeof gameChecks> | undefined) {
    return (doc: StoredMatchDoc, left: boolean) =>
        resultFor(doc, left) !== undefined &&
        (!checks ||
            (checks.map(doc.d) &&
                checks.own(left ? doc.x : doc.y) &&
                checks.theirs(left ? doc.y : doc.x)));
}

interface MemberTally {
    userId: string;
    name: string | null;
    bestRank: number | null;
    /** seasons the player was part of the side */
    seasons: number;
    record: Wld;
    last: number;
}

async function computeCompare(seasons: CompareSeason[], overlap: boolean, filter?: GameFilter) {
    await loadCodeBook();
    const fits = playable(filter && gameChecks(filter));
    const label = labeler();
    const total = newH2hTally();
    const members = { a: new Map<string, MemberTally>(), b: new Map<string, MemberTally>() };

    /** A player of a side this season (never-met players too, with a 0–0 record). */
    const join = (side: Map<string, MemberTally>, p: { userId: string; rank: number | null; name?: string | undefined }) => {
        const entry = side.get(p.userId) ?? {
            userId: p.userId,
            name: nameOfUser(p.userId, p.name),
            bestRank: null,
            seasons: 0,
            record: [0, 0, 0] as Wld,
            last: 0,
        };
        entry.seasons++;
        if (p.rank !== null && (entry.bestRank === null || p.rank < entry.bestRank)) {
            entry.bestRank = p.rank;
        }
        side.set(p.userId, entry);
    };

    const perSeason = [];
    for (const season of seasons) {
        const codes = seasonCodes(season, overlap);
        for (const p of season.a.players ?? []) join(members.a, p);
        for (const p of season.b.players ?? []) {
            // a shared player left to side 1 isn't one of side 2's
            const code = playerCodeOf(p.userId);
            if (code === undefined || codes.b?.has(code)) join(members.b, p);
        }
        const row = {
            seasonId: season.seasonId,
            name: season.name,
            boundsA: season.a.bounds ?? null,
            bounds: season.b.bounds ?? null,
            groupA: codes.a.size,
            group: codes.b?.size ?? 0,
            record: [0, 0, 0] as Wld,
            last: 0,
        };
        perSeason.push(row);

        await eachGameBetween(
            season.seasonId,
            [...codes.a.keys()],
            codes.b && [...codes.b.keys()],
            (doc) => {
                for (const left of sidesOf(doc, codes.a, codes.b)) {
                    if (!fits(doc, left)) continue;
                    const i = resultFor(doc, left)!;
                    const mine = members.a.get(codes.a.get(left ? doc.a : doc.b)!);
                    const theirs = codes.b && members.b.get(codes.b.get(left ? doc.b : doc.a)!);
                    count(
                        total,
                        i,
                        label.map(doc.d),
                        label.loadout(left ? doc.x : doc.y),
                        label.loadout(left ? doc.y : doc.x),
                        doc.t,
                    );
                    for (const member of [mine, theirs]) {
                        if (!member) continue;
                        member.record[i]++;
                        member.last = Math.max(member.last, doc.t);
                    }
                    row.record[i]++;
                    row.last = Math.max(row.last, doc.t);
                }
            },
        );
    }

    const iso = (t: number) => (t ? new Date(t * 60_000).toISOString() : null);
    /** everyone on a side; never-met players have a 0–0 record */
    const list = (side: Map<string, MemberTally>) =>
        [...side.values()]
            .map((o) => ({
                userId: o.userId,
                name: o.name,
                alias: playerNames[o.userId] ?? null,
                rank: o.bestRank,
                seasons: o.seasons,
                record: o.record,
                lastMet: iso(o.last),
            }))
            .sort(
                (x, y) =>
                    gamesOf(y.record) - gamesOf(x.record) ||
                    (x.rank ?? Infinity) - (y.rank ?? Infinity),
            );

    return {
        minGames: H2H_MIN_GAMES,
        labels: await label.labels(),
        total: {
            ...summarize(total, H2H_MIN_GAMES.total),
            mapList: byGames(total.maps),
            mapVariantList: byGames(total.mapVariants),
            mine: byGames(total.mine, COMPARE_LOADOUTS),
            theirs: byGames(total.theirs, COMPARE_LOADOUTS),
            mineVariants: byGames(total.mineVariants, COMPARE_LOADOUTS),
            theirsVariants: byGames(total.theirsVariants, COMPARE_LOADOUTS),
        },
        /** side 1 */
        players: list(members.a),
        /** side 2 (none against anyone) */
        opponents: list(members.b),
        /** newest first */
        seasons: perSeason.map(({ last, ...s }) => ({ ...s, lastMet: iso(last) })).reverse(),
    };
}

const GAME_SORTS: Record<MatchSort, (x: StoredMatchDoc, y: StoredMatchDoc) => number> = {
    newest: (x, y) => y.t - x.t,
    oldest: (x, y) => x.t - y.t,
    longest: (x, y) => unpackInfo(y.d).duration - unpackInfo(x.d).duration || y.t - x.t,
    shortest: (x, y) => unpackInfo(x.d).duration - unpackInfo(y.d).duration || y.t - x.t,
    rounds: (x, y) => unpackInfo(y.d).endRound - unpackInfo(x.d).endRound || y.t - x.t,
};

/** The games between the sides that the filters keep (each once), sorted. */
async function listGames(seasons: CompareSeason[], overlap: boolean, sort: MatchSort, filter?: GameFilter) {
    await loadCodeBook();
    const fits = playable(filter && gameChecks(filter));
    const found: { doc: StoredMatchDoc; seasonId: number }[] = [];
    for (const season of seasons) {
        const codes = seasonCodes(season, overlap);
        await eachGameBetween(
            season.seasonId,
            [...codes.a.keys()],
            codes.b && [...codes.b.keys()],
            (doc) => {
                if (sidesOf(doc, codes.a, codes.b).some((left) => fits(doc, left))) {
                    found.push({ doc, seasonId: season.seasonId });
                }
            },
        );
    }
    const order = GAME_SORTS[sort];
    return found.sort((x, y) => order(x.doc, y.doc));
}

export interface CompareOptions {
    overlap: boolean;
    filter?: GameFilter | undefined;
}

/** The cache key part of the options (a filter that keeps everything is none). */
const optionsKey = ({ overlap, filter }: CompareOptions) =>
    `${overlap ? 'both' : 'first'}:${isEmptyGameFilter(filter) ? '' : JSON.stringify(filter)}`;

/** Side 1 against side 2: the record, best and worst picks, each player's record. Null: unknown season. */
export async function runCompare(
    seasonParam: string | undefined,
    a: FirstSide,
    b: SideSpec,
    options: CompareOptions,
) {
    const sides = await resolveSides(seasonParam, a, b);
    if (!sides) return null;
    const filter = isEmptyGameFilter(options.filter) ? undefined : options.filter;
    const data = await cached(`compare:${sides.cacheKey}:${optionsKey(options)}`, () =>
        heavy(() => computeCompare(sides.groups, options.overlap, filter)),
    );
    return {
        ...data,
        ...seasonScope(seasonParam, sides.seasons),
        /** a player in both ranges counts on both sides */
        overlap: options.overlap,
        a: await describeSide(a),
        b: await describeSide(b),
        /** seasons whose leaderboard the server doesn't have yet (range sides) */
        missingSeasons: sides.missing,
    };
}

/** Whole sorted game lists (a player's every game for "all seasons"): only a few kept. */
const gamesCache = createCache({ max: 20 });

/**
 * The games between the sides, sorted, one page. The sorted list is cached 5 minutes, so
 * "show more" only formats the next page. Null: unknown season.
 */
export async function runCompareGames(
    seasonParam: string | undefined,
    a: FirstSide,
    b: SideSpec,
    options: CompareOptions & { sort: MatchSort; offset: number; limit: number },
) {
    const sides = await resolveSides(seasonParam, a, b);
    if (!sides) return null;
    const { sort, offset, limit } = options;
    const filter = isEmptyGameFilter(options.filter) ? undefined : options.filter;
    const all = await gamesCache(`games:${sides.cacheKey}:${optionsKey(options)}:${sort}`, () =>
        heavy(() => listGames(sides.groups, options.overlap, sort, filter)),
    );
    const items = await Promise.all(
        all.slice(offset, offset + limit).map(({ doc, seasonId }) => toApiMatch(doc, [], seasonId)),
    );
    return { total: all.length, offset, limit, items };
}
