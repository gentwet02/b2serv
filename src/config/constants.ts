const NK_API_BASE_URL = 'https://data.ninjakiwi.com/battles2';

export const NK_API = {
    LEADERBOARD: (seasonId: number, page?: number) =>
        `${NK_API_BASE_URL}/homs/season_${seasonId}/leaderboard${page ? `?page=${page}` : ''}`,
    PLAYER_MATCHES: (userId: string) => `${NK_API_BASE_URL}/users/${userId}/matches`,
    PLAYER_PROFILE: (userId: string) => `${NK_API_BASE_URL}/users/${userId}`,
    SEASONS: `${NK_API_BASE_URL}/homs`,
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

export const MAX_SEASON_PAGES = 1;
export const MAX_LEADERBOARD_PAGES = 20;
/**
 * Requests the match crawler keeps in flight. The rate limiter still caps requests per second;
 * this only lets the wait for one answer overlap with the next request.
 */
export const PLAYER_FETCH_CONCURRENCY = 4;
