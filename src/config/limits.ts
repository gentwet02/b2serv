// ---------------------------------------------------------------------------
// Request caps. The client relies on these: keep btdb2/src/config in step.
// ---------------------------------------------------------------------------

export const MAX_AVATAR_IDS = 100;
export const MAX_MATCHES_PAGE = 50;
export const MAX_COMPARE_GAMES_PAGE = 50;
export const MAX_H2H_OPPONENTS = 10;

// ---------------------------------------------------------------------------
// Heavy reads (stats, compare, head to head, opponents met), see utils/heavy.ts.
// HEAVY_MAX_RUNNING computed at once, a few more waiting, the rest turned away with a 503.
// ---------------------------------------------------------------------------

export const HEAVY_MAX_RUNNING = 2;
export const HEAVY_MAX_WAITING = 6;
/** how long a read may wait for its turn */
export const HEAVY_WAIT_MS = 20_000;
/** Every MongoDB read of the heavy paths stops after this (server side too). */
export const HEAVY_QUERY_MAX_MS = 30_000;

// ---------------------------------------------------------------------------
// NK's own limit (Cloudflare, per IP): ~100 requests a minute, then a 60 s block with
// "retry-after: 60". The caps are env.NK_REQUESTS_PER_SECOND / NK_REQUESTS_PER_MINUTE.
// ---------------------------------------------------------------------------

/** "retry-after: 0" comes right as a block ends: still wait a little before going on */
export const NK_RATE_LIMIT_MIN_PAUSE_MS = 2_000;

// ---------------------------------------------------------------------------
// Live matches: the only NK request a visitor can cause, see services/liveMatches.ts.
// ---------------------------------------------------------------------------

/** one NK read per player this often, everyone else gets that copy */
export const LIVE_PLAYER_FRESH_MS = 10 * 60_000;
/**
 * NK reads a minute for all visitors together. Small: the crawler reads every HoM player about
 * every 20 min, so a player with no stored match is rare, and these go before everything else.
 */
export const LIVE_GLOBAL_PER_MINUTE = 5;
/** at most one new NK read this often per visitor IP */
export const LIVE_IP_COOLDOWN_MS = 10_000;
