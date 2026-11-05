import type { VERSUS_RANGES } from '@/config/leaderboard';
import type { Model, NkApi, NkProfileUrl, NkUserId } from '@/types/ninjakiwi';
import type { PlayerTag } from '@/types/player';

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
    /** the player's tag (config/tags.ts) */
    t?: PlayerTag;
    n: string;
    d: string;
    /** the player's old names, for search */
    o?: string[];
    /** the player's current name, when they ranked under another one (past seasons) */
    c?: string;
}
