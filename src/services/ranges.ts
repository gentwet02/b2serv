import { listMatchSeasons } from '@/services/matchStore';
import { getLiveSeason, getSeasonById } from '@/services/seasons';

/** Leaderboard ranges shared by the compare (versus) and stats pages. */
export const VERSUS_RANGES = ['t10', 't25', 't50', 't100', 't25p', 't50p', 't75p', 'all'] as const;
export type VersusRange = (typeof VERSUS_RANGES)[number];

/** Players a range covers in a leaderboard of `size` players. */
export function rangeCount(range: VersusRange, size: number) {
    if (range === 'all') return size;
    if (range.endsWith('p')) return Math.ceil((size * Number(range.slice(1, -1))) / 100);
    return Math.min(Number(range.slice(1)), size);
}

/**
 * What a range leaves out at the top: a smaller range (top 50 without the top 10 → 11–50),
 * 'previous' for the next smaller threshold (the old ?band=1), or nothing.
 */
export type RangeExclude = VersusRange | 'previous' | null;

/** ?exclude=t10 (a range listed before `range`), or the old ?band=1. */
export function parseExclude(
    range: VersusRange,
    exclude: string | undefined,
    band: string | undefined,
): RangeExclude {
    const index = (VERSUS_RANGES as readonly string[]).indexOf(exclude ?? '');
    if (index >= 0 && index < VERSUS_RANGES.indexOf(range)) return VERSUS_RANGES[index]!;
    return band === '1' ? 'previous' : null;
}

/** The range an exclude names, for the response ('previous': the one listed before). */
export function excludedRange(range: VersusRange, exclude: RangeExclude): VersusRange | null {
    if (exclude !== 'previous') return exclude;
    return VERSUS_RANGES[VERSUS_RANGES.indexOf(range) - 1] ?? null;
}

/**
 * Ranks a range covers in one season, without the ones `exclude` covers: top 50 without
 * the top 10 → 11–50. 'previous': below the next smaller threshold (top 25% of 1200
 * players → 101–300). Empty (from > to) when the excluded part is the bigger one that season.
 */
export function rangeBounds(range: VersusRange, exclude: RangeExclude, size: number) {
    const to = rangeCount(range, size);
    if (!exclude) return { from: 1, to, size };
    if (exclude === 'previous') {
        const below = VERSUS_RANGES.map((r) => rangeCount(r, size)).filter((n) => n < to);
        return { from: (below.length ? Math.max(...below) : 0) + 1, to, size };
    }
    return { from: Math.min(rangeCount(exclude, size), to) + 1, to, size };
}

/** ?season=46 | all → the seasons asked for, newest last; null when unknown. */
export async function resolveSeasons(param: string | undefined) {
    if (param === 'all') {
        const stored = await listMatchSeasons();
        return stored.map((id) => getSeasonById(id) ?? { seasonId: id, name: `Season ${id + 1}` });
    }
    const season = param ? getSeasonById(Number(param)) : getLiveSeason();
    return season ? [season] : null;
}
