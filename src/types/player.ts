import type { Match } from '@/types/match';
import type { Model } from '@/types/ninjakiwi';

/**
 * GET /battles2/users/:id/matches — the player's last ~24 matches, newest first.
 * No paging: `next` and `prev` are always null and there is no `maxPages`.
 */
export interface PlayerMatchesResponse {
    error: string | null;
    success: boolean;
    body: Match[];
    model: Model;
    next: null;
    prev: null;
}

/**
 * A name the player no longer uses, and the seasons they ranked under it (seasonIds, newest
 * first). A name on no leaderboard has no seasons: `from` / `to` (inclusive) are the seasons it
 * was used in, worked out from the names the player ended the seasons around it with. A side
 * is missing when no dated name bounds it.
 */
export interface PastName {
    name: string;
    seasons: number[];
    from?: number;
    to?: number;
}
