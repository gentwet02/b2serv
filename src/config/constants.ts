export const API_ENDPOINTS = {
    LEADERBOARD: (seasonId: number, page?: number) =>
        `/homs/season_${seasonId}/leaderboard${page ? `?page=${page}` : ''}`,
    PLAYER_MATCHES: (userId: string) => `/users/${userId}/matches`,
    PLAYER_PROFILE: (userId: string) => `/users/${userId}`,
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
