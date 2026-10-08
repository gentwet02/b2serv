import { env } from '@/config/environment';
import { logger } from './logger';

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractUserId(profileUrl: string): string {
    return profileUrl.replace('https://data.ninjakiwi.com/battles2/users/', '');
}

// ---------------------------------------------------------------------------
// Rate limiter with two lanes.
// "high" is for requests a visitor is waiting on (profiles, a season opened for the first time).
// "low" is for background jobs (match crawl, scheduled refreshes, warming old seasons).
// Every time a slot opens, a waiting high request goes first, so a visitor waits at most
// one slot (1 / NK_REQUESTS_PER_SECOND) behind the crawler instead of queuing behind it.
// ---------------------------------------------------------------------------

export type Priority = 'high' | 'low';

const minIntervalMs = 1000 / Math.max(0.1, env.NK_REQUESTS_PER_SECOND);
const lanes: Record<Priority, Array<() => void>> = { high: [], low: [] };
let nextSlot = 0;
let pausedUntil = 0;
let pumping = false;

const stats = { requests: 0, rateLimited: 0, failed: 0, timedOut: 0 };
export const getNkClientStats = () => ({
    ...stats,
    queuedHigh: lanes.high.length,
    queuedLow: lanes.low.length,
    pausedForMs: Math.max(0, pausedUntil - Date.now()),
    requestsPerSecond: env.NK_REQUESTS_PER_SECOND,
});

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        while (lanes.high.length > 0 || lanes.low.length > 0) {
            const wait = Math.max(nextSlot, pausedUntil) - Date.now();
            if (wait > 0) {
                // re-check after waiting: a high request may have arrived meanwhile
                await delay(wait);
                continue;
            }
            const grant = lanes.high.shift() ?? lanes.low.shift();
            nextSlot = Date.now() + minIntervalMs;
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

export interface FetchOptions {
    priority?: Priority;
    /** Attempts before giving up. Defaults: 2 for high, NK_FETCH_RETRIES for low. */
    retries?: number;
    /** Abort a request that hangs. A hung request used to stall the whole crawler. */
    timeoutMs?: number;
}

export async function fetchWithRetry<T = any>(
    url: string,
    options: FetchOptions = {},
): Promise<T | null> {
    const priority = options.priority ?? 'low';
    const retries = options.retries ?? (priority === 'high' ? 2 : env.NK_FETCH_RETRIES);
    const timeoutMs = options.timeoutMs ?? (priority === 'high' ? 8_000 : 15_000);

    for (let attempt = 1; attempt <= retries; attempt++) {
        await acquireSlot(priority);
        stats.requests++;

        try {
            const response = await fetch(url, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(timeoutMs),
            });

            if (response.status === 429) {
                stats.rateLimited++;
                const wait =
                    retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt, 'low');
                pausedUntil = Math.max(pausedUntil, Date.now() + wait);
                logger.error(
                    `429 from NK (attempt ${attempt}/${retries}), pausing all requests for ${Math.round(wait / 1000)}s`,
                );
                continue;
            }

            if (response.status >= 500) {
                throw new Error(`HTTP ${response.status}`);
            }

            // other 4xx: no point retrying, return the body so the caller can log NK's error
            if (!response.ok) {
                logger.error(`HTTP ${response.status} for ${url}`);
                return (await response.json().catch(() => null)) as T | null;
            }

            return (await response.json()) as T;
        } catch (error) {
            if (error instanceof DOMException && error.name === 'TimeoutError') stats.timedOut++;
            logger.error(`Fetch failed for ${url} (attempt ${attempt}/${retries}): ${error}`);
            if (attempt < retries) await delay(backoffMs(attempt, priority));
        }
    }

    stats.failed++;
    logger.error(`Giving up on ${url} after ${retries} attempts`);
    return null;
}
