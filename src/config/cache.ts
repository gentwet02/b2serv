/** Stats answers computed in the last 2 minutes (the cubes behind them are cached longer). */
export const STATS_RESPONSE_TTL_MS = 2 * 60_000;
export const STATS_CUBE_TTL_MS = { live: 10 * 60_000, past: 6 * 60 * 60_000 };
export const STATS_MAX_CUBES = 200;

export const MATCH_OPTIONS_TTL_MS = 60_000;
export const LIVE_MATCHES_MAX_CACHED = 2000;
/** Decoded profile documents, by player code. Small: one entry is a few hundred bytes. */
export const PROFILES_MAX_CACHED = 5000;

/** How often the server re-reads what other processes (import scripts) added. */
export const CODE_BOOK_SYNC_MS = 60_000;
