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
export const PLAYER_FETCH_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Match crawler
// ---------------------------------------------------------------------------

/** Players read at the same time. The real pace is set by NK_REQUESTS_PER_SECOND. */
export const CRAWL_CONCURRENCY = 2;
/** Pages of one player's match history read per crawl, at most (newest first). */
export const MATCH_HISTORY_MAX_PAGES = 10;
/** Already stored matches in a row that prove we caught up with a player's history. */
export const MATCH_HISTORY_OVERLAP = 3;
/** Extra passes over the players NK did not answer for, at the end of a crawl. */
export const CRAWL_RETRY_PASSES = 3;
/** Pause before retry pass n: n × this. */
export const CRAWL_RETRY_PAUSE_MS = 60_000;
/** Attempts to write one batch of matches to the database. */
export const STORE_ATTEMPTS = 3;
export const MAX_UNSAVED = 20_000;

export const MATCH_SORTS = ['newest', 'oldest', 'longest', 'shortest', 'rounds'] as const;
export const MAX_HEROES = 2;
export const MAX_TOWERS = 6;
