import type { VERSUS_RANGES } from '@/config/leaderboard';
import type { Model, NkApi, NkProfileUrl, NkUserId } from '@/types/ninjakiwi';

export type VersusRange = (typeof VERSUS_RANGES)[number];

export interface LeaderboardPlayer {
    displayName: string;
    score: number;
    currentlyInHoM: boolean;
    profile: NkProfileUrl;
}

export interface LeaderboardResponse {
    error: string | null;
    success: boolean;
    body: LeaderboardPlayer[];
    model: Model;
    next: NkApi | null;
    prev: NkApi | null;
    maxPages: number;
}

export interface LeaderboardPlayerEncoded {
    i: NkUserId;
    r?: string;
    n: string;
    d: string;
    /** the player's other names (their current one too, on a past season), for search */
    o?: string[];
}
