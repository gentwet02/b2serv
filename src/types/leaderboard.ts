import type { Model, NkApi } from '@/types/ninjakiwi';

export interface LeaderboardPlayer {
    displayName: string;
    score: number;
    currentlyInHoM: boolean;
    profile: string;
}

export interface LeaderboardDocument {
    _id?: string;
    seasonId: number;
    players: LeaderboardPlayer[];
    createdAt: Date;
    pageCount: number;
}

export interface LeadrboardResponse {
    error: string;
    success: boolean;
    body: LeaderboardPlayer[];
    model: Model;
    next: NkApi | null;
    prev: NkApi | null;
    maxPages: number;
}

export interface LeaderboardPlayerEncoded {
    i: string;
    r?: string;
    n: string;
    d: string;
}

export interface CachedLeaderboards {
    [key: number]: LeaderboardPlayerEncoded[];
}
