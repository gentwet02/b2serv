import type { Match } from '@/types/match';
import type { Model, NkApi } from '@/types/ninjakiwi';

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

export interface PlayerMatchesResponse {
    error: string;
    success: boolean;
    body: Match[];
    model: Model;
    next: NkApi | null;
    prev: NkApi | null;
    maxPages: number;
}

export interface PlayerHistory {
    /** matches that passed the filter, newest first */
    matches: Match[];
    pages: number;
    /** false: a request failed — read this player again later */
    ok: boolean;
    /** true: we met matches already stored, or reached the end of NK's history */
    complete: boolean;
}
