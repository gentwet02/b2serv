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
