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
 * first). A name on no leaderboard has no seasons: `after` / `before` are the seasons of the
 * dated names around it in the player's name order, so it was used in between.
 */
export interface PastName {
    name: string;
    seasons: number[];
    after?: number;
    before?: number;
}
