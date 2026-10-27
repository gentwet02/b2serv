import { listMatchSeasons } from '@/services/matchStore';
import { getLiveSeason, getSeasonById } from '@/services/seasons';

/** Leaderboard ranges the stats and compare sides can be. */
export const VERSUS_RANGES = ['t10', 't25', 't50', 't100', 't25p', 't50p', 't75p', 'all'] as const;
export type VersusRange = (typeof VERSUS_RANGES)[number];

/** Players a range covers in a leaderboard of `size` players. */
export function rangeCount(range: VersusRange, size: number) {
    if (range === 'all') return size;
    if (range.endsWith('p')) return Math.ceil((size * Number(range.slice(1, -1))) / 100);
    return Math.min(Number(range.slice(1)), size);
}

/** A smaller range left out at the top of a range (top 50 without the top 10 → 11–50), or none. */
export type RangeExclude = VersusRange | null;

/** ?exclude=t10: kept when it's a range listed before `range`. */
export function parseExclude(range: VersusRange, exclude: string | undefined): RangeExclude {
    const index = (VERSUS_RANGES as readonly string[]).indexOf(exclude ?? '');
    return index >= 0 && index < VERSUS_RANGES.indexOf(range) ? VERSUS_RANGES[index]! : null;
}

/**
 * Ranks a range covers in one season, without the ones `exclude` covers: top 50 without
 * the top 10 → 11–50. Empty (from > to) when the excluded part is the bigger one that season.
 */
export function rangeBounds(range: VersusRange, exclude: RangeExclude, size: number) {
    const to = rangeCount(range, size);
    if (!exclude) return { from: 1, to, size };
    return { from: Math.min(rangeCount(exclude, size), to) + 1, to, size };
}

/** "40-47" → the two ends, smallest first; null for anything else. */
export function parseSeasonRange(param: string | undefined) {
    const m = /^(\d{1,4})-(\d{1,4})$/.exec(param ?? '');
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return { from: Math.min(a, b), to: Math.max(a, b) };
}

/** ?season=46 | 40-47 | all → the seasons asked for, newest last; null when unknown or none stored. */
export async function resolveSeasons(param: string | undefined) {
    const named = (id: number) => getSeasonById(id) ?? { seasonId: id, name: `Season ${id + 1}` };
    if (param === 'all') return (await listMatchSeasons()).map(named);
    const range = parseSeasonRange(param);
    if (range) {
        const ids = (await listMatchSeasons()).filter((id) => id >= range.from && id <= range.to);
        return ids.length ? ids.map(named) : null;
    }
    const season = param ? getSeasonById(Number(param)) : getLiveSeason();
    return season ? [season] : null;
}

/**
 * How a response names its seasons: one season (its id and name), or several together
 * ('all', with "All seasons" or "Seasons 41–48").
 */
export function seasonScope(param: string | undefined, seasons: { seasonId: number; name: string }[]) {
    if (param === 'all') return { season: 'all' as const, seasonName: 'All seasons' };
    const range = parseSeasonRange(param);
    if (range && seasons.length > 1) {
        return {
            season: 'all' as const,
            seasonName: `Seasons ${range.from + 1}–${range.to + 1}`,
            /** the first and last season asked for */
            seasonRange: [range.from, range.to] as [number, number],
        };
    }
    return { season: seasons[0]!.seasonId, seasonName: seasons[0]!.name };
}
