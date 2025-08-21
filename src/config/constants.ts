const NK_API = 'https://data.ninjakiwi.com/battles2';

export const API_ENDPOINTS = {
    LEADERBOARD: (seasonId: number, page?: number) =>
        `${NK_API}/homs/season_${seasonId}/leaderboard${page ? `?page=${page}` : ''}`,
    PLAYER_MATCHES: (userId: string) => `${NK_API}/users/${userId}/matches`,
    PLAYER_PROFILE: (userId: string) => `${NK_API}/users/${userId}`,
    SEASONS: `${NK_API}/homs`,
} as const;

export const ERROR_MESSAGES = {
    NO_DATA: 'No data available',
    SERVER_ERROR: 'Internal server error',
    NOT_FOUND: 'Resource not found',
    INVALID_REQUEST: 'Invalid request parameters',
    DATABASE_ERROR: 'Database operation failed',
    EXTERNAL_API_ERROR: 'External API request failed',
} as const;

export const COLLECTIONS = {
    MATCHES: 'matches',
    PLAYERS: 'players',
    LEADERBOARDS: 'leaderboards',
} as const;
