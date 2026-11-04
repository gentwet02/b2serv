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
// Live matches: the only NK request a visitor can cause, see services/liveMatches.ts.
// ---------------------------------------------------------------------------

/** one NK read per player this often, everyone else gets that copy */
export const LIVE_PLAYER_FRESH_MS = 10 * 60_000;
/** NK reads a minute for all visitors together */
export const LIVE_GLOBAL_PER_MINUTE = 20;
/** at most one new NK read this often per visitor IP */
export const LIVE_IP_COOLDOWN_MS = 10_000;
