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
