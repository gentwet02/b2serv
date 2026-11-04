import { VERSUS_RANGES } from '@/config/leaderboard';
import type { VersusRange } from '@/types/leaderboard';

const versusRanges: ReadonlySet<string> = new Set(VERSUS_RANGES);

export function isVersusRange(value: string): value is VersusRange {
    return versusRanges.has(value);
}
