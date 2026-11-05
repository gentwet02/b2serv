import type { PLAYER_TAGS } from '@/config/tags';
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

export type PlayerTag = keyof typeof PLAYER_TAGS;
