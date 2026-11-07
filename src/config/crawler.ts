// ---------------------------------------------------------------------------
// Leaderboard and player reads
// ---------------------------------------------------------------------------

export const MAX_SEASON_PAGES = 1;
export const PLAYER_FETCH_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Match crawler
// ---------------------------------------------------------------------------

/** Players read at the same time. The real pace is set by the rate limiter (utils/helpers.ts). */
export const CRAWL_CONCURRENCY = 2;
/** Attempts to write one batch of matches to the database. */
export const STORE_ATTEMPTS = 3;
export const MAX_UNSAVED = 20_000;

// ---------------------------------------------------------------------------
// Read schedules: when each player's matches and profile are read (services/readSchedule.ts)
// ---------------------------------------------------------------------------

/** How often the crawler and the profile sweep look for players due a read. */
export const SCHEDULE_TICK_MS = 15_000;
/** Read a player this long after their Cloudflare copy expires, so the new copy is there. */
export const SCHEDULE_EXPIRY_MARGIN_MS = 5_000;
/** A player NK did not answer for is read again this long after. */
export const SCHEDULE_RETRY_MS = 60_000;
/** A player off the roster this long leaves the schedule (banned, deleted, out of HoM). */
export const SCHEDULE_DROP_AFTER_MS = 3600_000;

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
