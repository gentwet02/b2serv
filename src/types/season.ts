import type { Model, NkApi } from '@/types/ninjakiwi';

export interface SeasonsResponse {
    error: string | null;
    success: boolean;
    body: Season[];
    model: Model;
    next: NkApi | null;
    prev: NkApi | null;
}

export interface Season {
    id: string;
    name: SeasonName;
    start: number;
    end: number;
    live: boolean;
    totalScores: number;
    leaderboard: NkApi;
}

export type SeasonName = `Season ${number}`;

/** One season of a comparison and the opponents counted in it (rank in that season). */
export interface VersusSeason {
    seasonId: number;
    name: string;
    /** ranks counted and leaderboard size (range mode) */
    bounds?: { from: number; to: number; size: number } | undefined;
    opponents: { userId: string; rank: number | null; name?: string | undefined }[];
}
