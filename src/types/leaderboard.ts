import type { Model, NkApi } from './ninjakiwi';

export interface LeaderboardPlayer {
    /** The display name for this user */
    displayName: string;
    /** The HoM score */
    score: number;
    /** When true, the player is currenty in the HoM. This might be false if the user has been demoted from HoM by finishing in the demotion zone of an arena league */
    currentlyInHoM: boolean;
    /** URL to the players public profile */
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
