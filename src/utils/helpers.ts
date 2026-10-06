import { env } from '@/config/environment';
import { logger } from './logger';

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @deprecated use season.seasonId (services/seasons.ts) */
export function extractSeasonId(seasonName: string): number {
    return parseInt(seasonName.replace('Season ', '')) - 1;
}

export function extractUserId(profileUrl: string): string {
    return profileUrl.replace('https://data.ninjakiwi.com/battles2/users/', '');
}

const minIntervalMs = 1000 / Math.max(0.1, env.NK_REQUESTS_PER_SECOND);
let nextSlot = 0;
let pausedUntil = 0;

const stats = { requests: 0, rateLimited: 0, failed: 0 };
export const getNkClientStats = () => ({
    ...stats,
    pausedForMs: Math.max(0, pausedUntil - Date.now()),
    requestsPerSecond: env.NK_REQUESTS_PER_SECOND,
});

async function acquireSlot() {
    for (;;) {
        const now = Date.now();
        const start = Math.max(now, nextSlot, pausedUntil);
        nextSlot = start + minIntervalMs;
        if (start > now) await delay(start - now);
        if (Date.now() >= pausedUntil) return;
    }
}

function backoffMs(attempt: number) {
    return Math.min(10_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
}

function retryAfterMs(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export async function fetchWithRetry<T = any>(url: string): Promise<T | null> {
    for (let attempt = 1; attempt <= env.NK_FETCH_RETRIES; attempt++) {
        await acquireSlot();
        stats.requests++;

        try {
            const response = await fetch(url, { headers: { Accept: 'application/json' } });

            if (response.status === 429) {
                stats.rateLimited++;
                const wait =
                    retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt);
                pausedUntil = Math.max(pausedUntil, Date.now() + wait);
                logger.error(
                    `429 from NK (attempt ${attempt}/${env.NK_FETCH_RETRIES}), pausing all requests for ${Math.round(wait / 1000)}s`,
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
            logger.error(
                `Fetch failed for ${url} (attempt ${attempt}/${env.NK_FETCH_RETRIES}): ${error}`,
            );
            if (attempt < env.NK_FETCH_RETRIES) await delay(backoffMs(attempt));
        }
    }

    stats.failed++;
    logger.error(`Giving up on ${url} after ${env.NK_FETCH_RETRIES} attempts`);
    return null;
}
