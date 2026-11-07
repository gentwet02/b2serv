import { env } from '@/config/environment';
import { NK_RATE_LIMIT_MIN_PAUSE_MS } from '@/config/limits';
import { NK_USER_URL_PREFIX } from '@/config/nk';
import type { NkAnswer, NkUserId } from '@/types/ninjakiwi';
import { logger } from './logger';

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** NK's own profile links are trusted: the id isn't checked again. */
export function extractUserId(profileUrl: string): NkUserId {
    return profileUrl.replace(NK_USER_URL_PREFIX, '') as NkUserId;
}

// ---------------------------------------------------------------------------
// Rate limiter: one queue per priority, and two caps for all of them together.
// Every time a slot opens it goes to the highest lane with a request waiting:
//  - high:   a visitor is waiting on it (live matches)
//  - normal: the seasons list and the live leaderboard, every NK_FETCH_INTERVAL
//  - low:    the read schedules (player matches and profiles), warming past seasons
//  - idle:   clans, read at most once a day: only when nothing else waits
// No job has a fixed share: whatever the lanes above leave goes to the ones below, so the
// schedules get most of the minute when visitors are quiet, and slip a little when they're not.
// Caps: requests are spaced by 1 / NK_REQUESTS_PER_SECOND, and at most NK_REQUESTS_PER_MINUTE
// go out in any 60 s. NK's limit is per minute (~100, per IP, every endpoint together): going
// past it blocks every request for 60 s, so the minute cap matters more than the spacing.
// ---------------------------------------------------------------------------

export type Priority = 'high' | 'normal' | 'low' | 'idle';
const LANE_ORDER: Priority[] = ['high', 'normal', 'low', 'idle'];

const minIntervalMs = 1000 / Math.max(0.1, env.NK_REQUESTS_PER_SECOND);
const perMinute = Math.max(1, env.NK_REQUESTS_PER_MINUTE);
const lanes: Record<Priority, Array<() => void>> = { high: [], normal: [], low: [], idle: [] };
/** the requests of the last 60 s, oldest first */
const granted: { at: number; priority: Priority }[] = [];
let nextSlot = 0;
let pausedUntil = 0;
let pumping = false;

const stats = { requests: 0, rateLimited: 0, failed: 0, timedOut: 0, unchanged: 0 };
export function getNkClientStats() {
    const now = Date.now();
    const recent = granted.filter((g) => now - g.at < 60_000);
    const byLane = (pick: (lane: Priority) => number) =>
        Object.fromEntries(LANE_ORDER.map((lane) => [lane, pick(lane)]));
    return {
        ...stats,
        queued: byLane((lane) => lanes[lane].length),
        lastMinute: recent.length,
        lastMinuteByLane: byLane((lane) => recent.filter((g) => g.priority === lane).length),
        pausedForMs: Math.max(0, pausedUntil - now),
        requestsPerSecond: env.NK_REQUESTS_PER_SECOND,
        requestsPerMinute: perMinute,
    };
}

function minuteWaitMs(now: number) {
    while (granted.length > 0 && now - granted[0]!.at >= 60_000) granted.shift();
    return granted.length < perMinute ? 0 : granted[0]!.at + 60_000 - now;
}

function nextWaiting(): Priority | undefined {
    return LANE_ORDER.find((lane) => lanes[lane].length > 0);
}

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        while (nextWaiting()) {
            const now = Date.now();
            const wait = Math.max(Math.max(nextSlot, pausedUntil) - now, minuteWaitMs(now));
            if (wait > 0) {
                // re-check after waiting: a higher request may have arrived meanwhile
                await delay(wait);
                continue;
            }
            const priority = nextWaiting()!;
            const grant = lanes[priority].shift();
            nextSlot = now + minIntervalMs;
            granted.push({ at: now, priority });
            grant?.();
        }
    } finally {
        pumping = false;
    }
}

function acquireSlot(priority: Priority): Promise<void> {
    return new Promise((resolve) => {
        lanes[priority].push(resolve);
        void pump();
    });
}

function backoffMs(attempt: number, priority: Priority) {
    // a visitor is waiting on high requests: retry sooner
    const base = priority === 'high' ? 500 : 2_000;
    const cap = priority === 'high' ? 3_000 : 10_000;
    return Math.min(cap, base * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300);
}

function retryAfterMs(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function ageOf(headers: Headers): number | null {
    const age = Number(headers.get('age'));
    return headers.has('age') && Number.isFinite(age) ? age : null;
}

export interface FetchOptions {
    priority?: Priority;
    /** Attempts before giving up. Defaults: 2 for high, NK_FETCH_RETRIES for the rest. */
    retries?: number;
    /** Abort a request that hangs. A hung request used to stall the whole crawler. */
    timeoutMs?: number;
    /** The etag of the last read: the answer is "unchanged" when NK's page has the same one. */
    etag?: string | null;
}

/** An NK read, with its etag and Cloudflare's `age`. Never throws. */
export async function fetchNk<T = any>(
    url: string,
    options: FetchOptions = {},
): Promise<NkAnswer<T>> {
    const priority = options.priority ?? 'low';
    const retries = options.retries ?? (priority === 'high' ? 2 : env.NK_FETCH_RETRIES);
    const timeoutMs = options.timeoutMs ?? (priority === 'high' ? 8_000 : 15_000);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.etag) headers['If-None-Match'] = options.etag;

    for (let attempt = 1; attempt <= retries; attempt++) {
        await acquireSlot(priority);
        stats.requests++;

        try {
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
            const etag = response.headers.get('etag');
            const ageS = ageOf(response.headers);

            if (response.status === 429) {
                stats.rateLimited++;
                await response.body?.cancel();
                const wait = Math.max(
                    NK_RATE_LIMIT_MIN_PAUSE_MS,
                    retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt, 'low'),
                );
                pausedUntil = Math.max(pausedUntil, Date.now() + wait);
                logger.error(
                    `429 from NK (attempt ${attempt}/${retries}), pausing all requests for ${Math.round(wait / 1000)}s`,
                );
                continue;
            }

            // a 304, or Cloudflare ignoring If-None-Match but sending the same page
            if (response.status === 304 || (options.etag && etag === options.etag)) {
                stats.unchanged++;
                await response.body?.cancel();
                const known = etag ?? options.etag ?? null;
                return { data: null, status: 'unchanged', etag: known, ageS };
            }

            if (response.status >= 500) {
                throw new Error(`HTTP ${response.status}`);
            }

            // other 4xx: no point retrying, return the body so the caller can log NK's error
            if (!response.ok) {
                logger.error(`HTTP ${response.status} for ${url}`);
                const data = (await response.json().catch(() => null)) as T | null;
                return { data, status: 'ok', etag: null, ageS };
            }

            return { data: (await response.json()) as T, status: 'ok', etag, ageS };
        } catch (error) {
            if (error instanceof DOMException && error.name === 'TimeoutError') stats.timedOut++;
            logger.error(`Fetch failed for ${url} (attempt ${attempt}/${retries}): ${error}`);
            if (attempt < retries) await delay(backoffMs(attempt, priority));
        }
    }

    stats.failed++;
    logger.error(`Giving up on ${url} after ${retries} attempts`);
    return { data: null, status: 'failed', etag: null, ageS: null };
}

/** The body of an NK read, null when NK did not answer. */
export async function fetchWithRetry<T = any>(
    url: string,
    options: FetchOptions = {},
): Promise<T | null> {
    return (await fetchNk<T>(url, options)).data;
}
