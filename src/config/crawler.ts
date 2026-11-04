// ---------------------------------------------------------------------------
// Leaderboard and player reads
// ---------------------------------------------------------------------------

export const MAX_SEASON_PAGES = 1;
export const MAX_LEADERBOARD_PAGES = 20;
export const PLAYER_FETCH_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Match crawler
// ---------------------------------------------------------------------------

/** Players read at the same time. The real pace is set by NK_REQUESTS_PER_SECOND. */
export const CRAWL_CONCURRENCY = 2;
/** Extra passes over the players NK did not answer for, at the end of a crawl. */
export const CRAWL_RETRY_PASSES = 3;
/** Pause before retry pass n: n × this. */
export const CRAWL_RETRY_PAUSE_MS = 60_000;
/** Attempts to write one batch of matches to the database. */
export const STORE_ATTEMPTS = 3;
export const MAX_UNSAVED = 20_000;

// ---------------------------------------------------------------------------
// Profile sweep and clans
// ---------------------------------------------------------------------------

export const PROFILE_SWEEP_CONCURRENCY = 2;
export const PROFILE_SWEEP_BATCH = 50;
/** after a season starts, keep reading the previous season's players this long */
export const PROFILE_SWEEP_PREVIOUS_SEASON_MS = 3 * 24 * 3600_000;
/** a clan is read again once its last reading is this old */
export const CLAN_REFRESH_MS = 24 * 3600_000;
export const CLAN_FETCH_CONCURRENCY = 2;
