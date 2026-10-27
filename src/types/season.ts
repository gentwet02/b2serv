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

/** One side of a comparison in a season: a player, or a range of that season's leaderboard. */
export interface CompareSide {
    /** ranks counted and leaderboard size (range mode) */
    bounds?: { from: number; to: number; size: number } | undefined;
    /** null: anyone (side 2 only) */
    players: { userId: string; rank: number | null; name?: string | undefined }[] | null;
}

/** One season of a comparison: who is on each side that season (rank in that season). */
export interface CompareSeason {
    seasonId: number;
    name: string;
    a: CompareSide;
    b: CompareSide;
}
