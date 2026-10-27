import { CODE_BITS, loadCodeBook, nameOf } from '@/services/codeBook';
import { getAssetUrl } from '@/services/matchMeta';
import { RESULT_INDEX, type Wld, type WldIndex } from '@/services/h2h';
import {
    collection,
    knownHeroBases,
    mapExpr,
    opposingResult,
    unpackLoadout,
} from '@/services/matchStore';
import { getLiveSeason } from '@/services/seasons';
import { HEAVY_QUERY_MAX_MS } from '@/utils/heavy';
import { logger } from '@/utils/logger';
import {
    currentMapId,
    heroBase,
    mapBaseKey,
    mapVariant,
    type MapVariant,
} from '@/utils/matchLabels';

/**
 * Stats page: hero, tower, strat (hero + 3 towers) and map usage and win rates,
 * from the side of a group of players (one player, a leaderboard range, everyone).
 *
 * One aggregation per season and group builds a "cube": the group's games counted by
 * loadout × map × result. It's small (tens of thousands of rows at most) and cached,
 * and every filter (map, hero, towers) is then worked out from it in memory.
 */

interface CubeRow {
    loadout: number;
    map: number;
    result: WldIndex;
    n: number;
}

/** A season and the players counted in it. `codes` null: everyone, both sides of every game. */
export interface StatsSeasonGroup {
    seasonId: number;
    codes: number[] | null;
    /** only their games against these players (null or missing: against anyone) */
    against?: number[] | null | undefined;
    /** and only when the opponent's loadout fits: the condition with the opponent as a (x) or b (y) */
    opponent?: SideExprs | null | undefined;
    /** identifies the group (and who they played) in the cache ("t25", "p:1234|vs:t100") */
    groupKey: string;
}

export interface StatsQuery {
    seasons: StatsSeasonGroup[];
    /** a base map key ("oasis"), any version, or only its classic / reversed one */
    map?: { base: string; variant?: MapVariant | undefined } | undefined;
    /** any variant of `base`, or exactly `hero` */
    hero?: { base: string; hero?: string | undefined } | undefined;
    towers: string[]; // ≤ 3, all in the loadout
    /** exclusions: loadouts without these heroes (a base, or one variant) */
    exHeroes: { base: string; hero?: string | undefined }[];
    /** exclusions: loadouts with none of these towers */
    exTowers: string[];
    /** exclusions: games not on these maps (or map versions) */
    exMaps: { base: string; variant?: MapVariant | undefined }[];
}

/** A loadout condition ($expr) for each place a player can have in a game. */
export interface SideExprs {
    onX: object | null;
    onY: object | null;
}

export interface StatsRow {
    key: string;
    record: Wld;
}

const CUBE_TTL_MS = { live: 10 * 60_000, past: 6 * 60 * 60_000 };
const MAX_CUBES = 200;
/** Strats sent back, most played first. */
const MAX_LOADOUTS = 500;

const cubeCache = new Map<string, { rows: CubeRow[]; expires: number }>();
const pending = new Map<string, Promise<CubeRow[]>>();

async function buildCube(
    seasonId: number,
    codes: number[] | null,
    against: number[] | null = null,
    opponent: SideExprs | null = null,
): Promise<CubeRow[]> {
    if (codes?.length === 0 || against?.length === 0) return [];
    const sides = [
        { player: 'a', other: 'b', loadout: '$x', left: true },
        { player: 'b', other: 'a', loadout: '$y', left: false },
    ];
    const merged = new Map<string, CubeRow>();
    for (const side of sides) {
        const pipeline: object[] = [];
        const match: Record<string, object> = {};
        if (codes) match[side.player] = { $in: codes };
        if (against) match[side.other] = { $in: against };
        // the opponent's loadout: on y when the group's player is a, on x when b
        const expr = opponent && (side.left ? opponent.onY : opponent.onX);
        if (expr) match.$expr = expr;
        if (Object.keys(match).length) pipeline.push({ $match: match });
        pipeline.push({
            $group: {
                _id: {
                    l: side.loadout,
                    m: mapExpr,
                    r: { $mod: ['$d', 2 ** CODE_BITS.result] },
                },
                n: { $sum: 1 },
            },
        });
        const rows = await collection(seasonId)
            .aggregate<{ _id: { l: number; m: number; r: number }; n: number }>(pipeline, {
                allowDiskUse: true,
                maxTimeMS: HEAVY_QUERY_MAX_MS,
            })
            .toArray();
        for (const { _id, n } of rows) {
            const leftResult = nameOf('result', _id.r);
            const result =
                RESULT_INDEX[side.left ? leftResult : (opposingResult[leftResult] ?? leftResult)];
            if (result === undefined) continue; // cancelled / lobby disconnect: not played
            const key = `${_id.l}:${_id.m}:${result}`;
            const row = merged.get(key);
            if (row) row.n += n;
            else merged.set(key, { loadout: _id.l, map: _id.m, result, n });
        }
    }
    return [...merged.values()];
}

/** The cube of one season and group, from the cache when fresh. */
function seasonCube({
    seasonId,
    codes,
    against,
    opponent,
    groupKey,
}: StatsSeasonGroup): Promise<CubeRow[]> {
    const key = `${seasonId}:${groupKey}`;
    const hit = cubeCache.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.rows);
    const running = pending.get(key);
    if (running) return running;

    const started = Date.now();
    const promise = buildCube(seasonId, codes, against ?? null, opponent ?? null)
        .then((rows) => {
            const live = getLiveSeason()?.seasonId === seasonId;
            if (cubeCache.size >= MAX_CUBES) cubeCache.clear();
            cubeCache.set(key, {
                rows,
                expires: Date.now() + (live ? CUBE_TTL_MS.live : CUBE_TTL_MS.past),
            });
            const ms = Date.now() - started;
            if (ms > 2000) logger.warn(`Slow stats cube ${key} (${ms}ms, ${rows.length} rows)`);
            return rows;
        })
        .finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
}

/** `work` on each item, two at a time (free tier friendly), results in order. */
async function twoAtATime<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await work(items[i]!);
        }
    };
    await Promise.all([worker(), worker()]);
    return out;
}

/** Cubes of several seasons, two aggregations at a time. */
const cubesOf = (seasons: StatsSeasonGroup[]) => twoAtATime(seasons, seasonCube);

const tally = (map: Map<string, Wld>, key: string, i: WldIndex, n: number) => {
    const record = map.get(key) ?? [0, 0, 0];
    record[i] += n;
    map.set(key, record);
};
const add = (map: Map<string, number>, key: string, n: number) =>
    map.set(key, (map.get(key) ?? 0) + n);
const gamesOf = (r: Wld) => r[0] + r[1] + r[2];
const rows = (map: Map<string, Wld>, limit = Infinity): StatsRow[] =>
    [...map]
        .map(([key, record]) => ({ key, record }))
        .sort((a, b) => gamesOf(b.record) - gamesOf(a.record))
        .slice(0, limit);
interface DecodedLoadout {
    base: string;
    hero: string;
    towers: string[];
    /** "Quincy|Alchemist,Druid,Ninja" (towers sorted) */
    key: string;
    /** its hero / one of its towers is excluded */
    heroOut: boolean;
    towersOut: boolean;
}

export async function computeStats(query: StatsQuery) {
    await loadCodeBook();
    const cubes = await cubesOf(query.seasons);
    const known = knownHeroBases();
    const { map, hero, towers, exHeroes, exTowers, exMaps } = query;

    const loadouts = new Map<number, DecodedLoadout>();
    const decode = (code: number) => {
        let found = loadouts.get(code);
        if (!found) {
            const { hero, towers } = unpackLoadout(code);
            const base = heroBase(hero, known);
            const sorted = [...new Set(towers)].sort();
            found = {
                base,
                hero,
                towers: sorted,
                key: `${base}|${sorted.join(',')}`,
                heroOut: exHeroes.some((h) => h.base === base && (!h.hero || h.hero === hero)),
                towersOut: sorted.some((t) => exTowers.includes(t)),
            };
            loadouts.set(code, found);
        }
        return found;
    };
    // a reversed map ("oasis_reversed") is a version of its base map ("oasis")
    const mapNames = new Map<string, Map<string, number>>(); // row key → raw id → games
    const mapKeys = new Map<
        number,
        { base: string; variant: MapVariant; split: string; raw: string; excluded: boolean }
    >();
    const mapOf = (code: number) => {
        let found = mapKeys.get(code);
        if (found === undefined) {
            const raw = nameOf('map', code);
            const variant = mapVariant(raw);
            const base = mapBaseKey(raw);
            // split rows: "oasis" (classic) and "oasis:reversed"
            const split = variant === 'reversed' ? `${base}:reversed` : base;
            const excluded = exMaps.some(
                (m) => m.base === base && (!m.variant || m.variant === variant),
            );
            found = { base, variant, split, raw, excluded };
            mapKeys.set(code, found);
        }
        return found;
    };
    const heroVariants = new Map<string, Map<string, number>>(); // base → raw hero → games

    const group: Wld = [0, 0, 0]; // every game of the group (on the map)
    const selection: Wld = [0, 0, 0]; // games with the focus (hero, towers) on the map
    const groupByMap = new Map<string, Wld>(); // base map and split keys
    const byMap = new Map<string, Wld>(); // base map
    const byMapVariant = new Map<string, Wld>(); // split keys
    const byHero = new Map<string, Wld>();
    const byTower = new Map<string, Wld>();
    const byLoadout = new Map<string, Wld>();
    const byVariant = new Map<string, Wld>(); // raw hero ("Quincy_Cyber")
    const byTrio = new Map<string, Wld>(); // the 3 towers, sorted, hero ignored
    const byLoadoutVariant = new Map<string, Wld>(); // "Quincy_Cyber|Alchemist,Druid,Ninja"
    const heroOptions = new Map<string, Map<string, number>>(); // base → raw hero → games
    const towerOptions = new Map<string, number>();
    const mapOptions = new Map<string, Map<MapVariant, number>>(); // base → variant → games

    for (const cube of cubes) {
        for (const row of cube) {
            const loadout = decode(row.loadout);
            const mk = mapOf(row.map);
            const { result: i, n } = row;
            const heroFits =
                !hero || (loadout.base === hero.base && (!hero.hero || loadout.hero === hero.hero));
            const heroOk = !loadout.heroOut && heroFits;
            const towersOk = !loadout.towersOut && towers.every((t) => loadout.towers.includes(t));

            for (const key of new Set([mk.base, mk.split])) {
                const raws = mapNames.get(key) ?? new Map<string, number>();
                // the base row shows the classic map's name and image
                add(raws, mk.raw, key === mk.base && mk.variant === 'reversed' ? 0 : n);
                mapNames.set(key, raws);
            }

            tally(groupByMap, mk.base, i, n);
            if (mk.split !== mk.base) tally(groupByMap, mk.split, i, n);
            const versions = mapOptions.get(mk.base) ?? new Map<MapVariant, number>();
            versions.set(mk.variant, (versions.get(mk.variant) ?? 0) + n);
            mapOptions.set(mk.base, versions);
            // an excluded map: still named and offered above, counted nowhere
            if (mk.excluded) continue;
            if (heroOk && towersOk) {
                tally(byMap, mk.base, i, n);
                tally(byMapVariant, mk.split, i, n);
            }
            if (map && (mk.base !== map.base || (map.variant && mk.variant !== map.variant))) {
                continue;
            }

            group[i] += n;
            // options: what can still be added without emptying the selection
            if (towersOk) {
                // every variant of every hero, even with a variant picked (to switch variants)
                const variants = heroOptions.get(loadout.base) ?? new Map<string, number>();
                add(variants, loadout.hero, n);
                heroOptions.set(loadout.base, variants);
            }
            if (heroOk && towersOk) for (const t of loadout.towers) add(towerOptions, t, n);
            if (!heroOk || !towersOk) continue;

            selection[i] += n;
            tally(byHero, loadout.base, i, n);
            for (const t of loadout.towers) tally(byTower, t, i, n);
            tally(byLoadout, loadout.key, i, n);
            tally(byVariant, loadout.hero, i, n);
            tally(byTrio, loadout.towers.join(','), i, n);
            tally(byLoadoutVariant, `${loadout.hero}|${loadout.towers.join(',')}`, i, n);
            const variants = heroVariants.get(loadout.base) ?? new Map<string, number>();
            add(variants, loadout.hero, n);
            heroVariants.set(loadout.base, variants);
        }
    }
    // heroes seen only in the options still need a label
    for (const loadout of loadouts.values()) {
        if (!heroVariants.has(loadout.base)) {
            heroVariants.set(loadout.base, new Map([[loadout.hero, 0]]));
        }
    }

    const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
    const labels = {
        maps: {} as Record<string, { map: string; image: string | null }>,
        heroes: {} as Record<string, { hero: string; portrait: string | null }>,
        /** raw hero ("Quincy_Cyber") → base and portrait, for the variant rows */
        variants: {} as Record<string, { base: string; portrait: string | null }>,
    };
    for (const [key, raws] of mapNames) {
        const raw = top(raws) ?? key;
        // renamed maps show their current name
        const current = currentMapId(raw);
        labels.maps[key] = {
            map: current,
            image: (await getAssetUrl('map', current)) ?? (await getAssetUrl('map', raw)) ?? null,
        };
    }
    for (const [base, variants] of heroVariants) {
        const raw = variants.has(base) ? base : (top(variants) ?? base);
        labels.heroes[base] = {
            hero: raw,
            portrait: (await getAssetUrl('hero', base)) ?? (await getAssetUrl('hero', raw)) ?? null,
        };
    }
    for (const variant of byVariant.keys()) {
        const base = heroBase(variant, known);
        labels.variants[variant] = {
            base,
            portrait: (await getAssetUrl('hero', variant)) ?? labels.heroes[base]?.portrait ?? null,
        };
    }

    return {
        /** the group's games (on the map), one per player side */
        group,
        /** the games matching the hero / towers focus (on the map) */
        selection,
        heroes: rows(byHero),
        /** one row per hero variant (skin) */
        heroVariants: rows(byVariant),
        towers: rows(byTower),
        loadouts: rows(byLoadout, MAX_LOADOUTS),
        loadoutCount: byLoadout.size,
        /** strats with the exact hero variant: "Quincy_Cyber|Alchemist,Druid,Ninja" */
        loadoutVariants: rows(byLoadoutVariant, MAX_LOADOUTS),
        loadoutVariantCount: byLoadoutVariant.size,
        /** strats without the hero: "Alchemist,Druid,Ninja" */
        trios: rows(byTrio, MAX_LOADOUTS),
        trioCount: byTrio.size,
        /** the focus on each map (ignores the map filter), with the group's games there */
        maps: rows(byMap).map((r) => ({
            ...r,
            total: gamesOf(groupByMap.get(r.key) ?? [0, 0, 0]),
        })),
        /** the same, classic and reversed apart ("oasis", "oasis:reversed") */
        mapVariants: rows(byMapVariant).map((r) => ({
            ...r,
            total: gamesOf(groupByMap.get(r.key) ?? [0, 0, 0]),
        })),
        options: {
            // the match filters' shape, so the client reuses its hero and tower chips
            heroes: await Promise.all(
                [...heroOptions]
                    .map(([base, variants]) => ({
                        base,
                        count: [...variants.values()].reduce((sum, n) => sum + n, 0),
                        variants: [...variants]
                            .map(([hero, count]) => ({ hero, count }))
                            .sort((a, b) => b.count - a.count),
                    }))
                    .sort((a, b) => a.base.localeCompare(b.base))
                    .map(async (h) => ({
                        ...h,
                        variants: await Promise.all(
                            h.variants.map(async (v) => ({
                                ...v,
                                portrait: await getAssetUrl('hero', v.hero),
                            })),
                        ),
                    })),
            ),
            towers: [...towerOptions]
                .map(([tower, count]) => ({ tower, count }))
                .sort((a, b) => a.tower.localeCompare(b.tower)),
            maps: [...mapOptions]
                .map(([key, versions]) => ({
                    key,
                    count: [...versions.values()].reduce((sum, n) => sum + n, 0),
                    variants: [...versions]
                        .map(([variant, count]) => ({ variant, count }))
                        .sort((a, b) => a.variant.localeCompare(b.variant)),
                }))
                .sort((a, b) => b.count - a.count),
        },
        labels,
    };
}

// ---------------------------------------------------------------------------
// Sides filtered separately: the opponents' heroes and towers to pick from
// ---------------------------------------------------------------------------

interface OpponentRow {
    /** the opponent's packed loadout */
    loadout: number;
    map: number;
    n: number;
}

const opponentCubes = new Map<string, { rows: OpponentRow[]; expires: number }>();

/** The opponents' loadouts × maps in the group's games (the group's loadout filter applied). */
async function buildOpponentCube(
    seasonId: number,
    codes: number[],
    against: number[] | null,
    own: SideExprs | null,
): Promise<OpponentRow[]> {
    if (codes.length === 0 || against?.length === 0) return [];
    const sides = [
        { player: 'a', other: 'b', theirs: '$y', left: true },
        { player: 'b', other: 'a', theirs: '$x', left: false },
    ];
    const merged = new Map<string, OpponentRow>();
    for (const side of sides) {
        const match: Record<string, object> = { [side.player]: { $in: codes } };
        if (against) match[side.other] = { $in: against };
        const expr = own && (side.left ? own.onX : own.onY);
        if (expr) match.$expr = expr;
        const rows = await collection(seasonId)
            .aggregate<{ _id: { l: number; m: number }; n: number }>(
                [
                    { $match: match },
                    { $group: { _id: { l: side.theirs, m: mapExpr }, n: { $sum: 1 } } },
                ],
                { allowDiskUse: true, maxTimeMS: HEAVY_QUERY_MAX_MS },
            )
            .toArray();
        for (const { _id, n } of rows) {
            const key = `${_id.l}:${_id.m}`;
            const row = merged.get(key);
            if (row) row.n += n;
            else merged.set(key, { loadout: _id.l, map: _id.m, n });
        }
    }
    return [...merged.values()];
}

export interface OpponentOptionsQuery {
    seasons: StatsSeasonGroup[];
    /** the group's own loadout filter, and its cache key */
    own: SideExprs | null;
    ownKey: string;
    map?: { base: string; variant?: MapVariant | undefined } | undefined;
    exMaps: { base: string; variant?: MapVariant | undefined }[];
    /** the opponents' current picks: an option must still fit them */
    hero?: { base: string; hero?: string | undefined } | undefined;
    towers: string[];
    exHeroes: { base: string; hero?: string | undefined }[];
    exTowers: string[];
}

/** The heroes (with variants) and towers the opponents can still be filtered on. */
export async function opponentOptions(query: OpponentOptionsQuery) {
    await loadCodeBook();
    const known = knownHeroBases();
    const cubes = await twoAtATime(
        query.seasons,
        async (g) => {
            const key = `${g.seasonId}:${g.groupKey}:own:${query.ownKey}`;
            const hit = opponentCubes.get(key);
            if (hit && hit.expires > Date.now()) return hit.rows;
            const rows = await buildOpponentCube(g.seasonId, g.codes ?? [], g.against ?? null, query.own);
            const live = getLiveSeason()?.seasonId === g.seasonId;
            if (opponentCubes.size >= MAX_CUBES) opponentCubes.clear();
            opponentCubes.set(key, {
                rows,
                expires: Date.now() + (live ? CUBE_TTL_MS.live : CUBE_TTL_MS.past),
            });
            return rows;
        },
    );

    const heroes = new Map<string, Map<string, number>>(); // base → raw hero → games
    const towers = new Map<string, number>();
    const { map, hero, exHeroes, exTowers, exMaps } = query;
    for (const rows of cubes) {
        for (const row of rows) {
            const raw = nameOf('map', row.map);
            const base = mapBaseKey(raw);
            const variant = mapVariant(raw);
            if (exMaps.some((m) => m.base === base && (!m.variant || m.variant === variant))) continue;
            if (map && (base !== map.base || (map.variant && variant !== map.variant))) continue;

            const loadout = unpackLoadout(row.loadout);
            const heroBaseName = heroBase(loadout.hero, known);
            const sorted = [...new Set(loadout.towers)];
            const heroOut = exHeroes.some(
                (h) => h.base === heroBaseName && (!h.hero || h.hero === loadout.hero),
            );
            const towersOk =
                !sorted.some((t) => exTowers.includes(t)) &&
                query.towers.every((t) => sorted.includes(t));
            const heroOk =
                !heroOut &&
                (!hero || (heroBaseName === hero.base && (!hero.hero || loadout.hero === hero.hero)));
            if (towersOk) {
                const variants = heroes.get(heroBaseName) ?? new Map<string, number>();
                add(variants, loadout.hero, row.n);
                heroes.set(heroBaseName, variants);
            }
            if (heroOk && towersOk) for (const t of sorted) add(towers, t, row.n);
        }
    }

    return {
        heroes: await Promise.all(
            [...heroes]
                .map(([base, variants]) => ({
                    base,
                    count: [...variants.values()].reduce((sum, n) => sum + n, 0),
                    variants: [...variants]
                        .map(([hero, count]) => ({ hero, count }))
                        .sort((a, b) => b.count - a.count),
                }))
                .sort((a, b) => a.base.localeCompare(b.base))
                .map(async (h) => ({
                    ...h,
                    variants: await Promise.all(
                        h.variants.map(async (v) => ({
                            ...v,
                            portrait: await getAssetUrl('hero', v.hero),
                        })),
                    ),
                })),
        ),
        towers: [...towers]
            .map(([tower, count]) => ({ tower, count }))
            .sort((a, b) => a.tower.localeCompare(b.tower)),
    };
}
