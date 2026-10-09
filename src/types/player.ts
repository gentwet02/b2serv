import type { Match } from '@/types/match';
import type { Model } from '@/types/ninjakiwi';

export interface PlayerDocument {
    _id?: string;
    userId: string;
    displayName: string;
    profile: string;
    lastSeen: Date;
    seasonData: {
        seasonId: number;
        score: number;
        currentlyInHoM: boolean;
        lastUpdated: Date;
    }[];
}

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
