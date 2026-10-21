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
 * Ranks a range covers in one season. `band`: only the ranks below the next smaller
 * threshold (top 25 → 11–25; top 25% of 1200 players → 101–300).
 */
export function rangeBounds(range: VersusRange, band: boolean, size: number) {
    const to = rangeCount(range, size);
    if (!band) return { from: 1, to, size };
    const below = VERSUS_RANGES.map((r) => rangeCount(r, size)).filter((n) => n < to);
    return { from: (below.length ? Math.max(...below) : 0) + 1, to, size };
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
