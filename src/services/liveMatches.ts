import { NK_API } from '@/config/constants';
import { loadCodeBook, playerCodeOf } from '@/services/codeBook';
import { fetchWithRetry } from '@/utils/helpers';
import { logger } from '@/utils/logger';

/**
 * A player's latest matches straight from Ninja Kiwi: the only NK request a visitor can cause
 * (fallback for players with no stored match this season). Bounded so it can't be spammed:
 *  - only players we already know (player_codes): no random ids;
 *  - one NK read per player per PLAYER_FRESH_MS, everyone else gets that copy;
 *  - at most GLOBAL_PER_MINUTE NK reads per minute for all visitors together;
 *  - at most one new NK read per IP_COOLDOWN_MS per visitor IP.
 * Over a limit, the last copy is served if there is one, otherwise a "busy" answer.
 * At worst this adds GLOBAL_PER_MINUTE requests a minute to NK, whatever visitors do.
 */

const PLAYER_FRESH_MS = 10 * 60_000;
const GLOBAL_PER_MINUTE = 20;
const IP_COOLDOWN_MS = 10_000;
const MAX_CACHED = 2000;

export interface NkMatchesAnswer {
    success: boolean;
    error: string | null;
    body?: unknown;
}

interface Entry {
    data: NkMatchesAnswer;
    fetchedAt: number;
}

export type LiveMatchesResult =
    | { status: 'ok'; entry: Entry }
    | { status: 'unknown' }
    | { status: 'busy'; retryAfterMs: number }
    | { status: 'unavailable' };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Entry | null>>();
const recentReads: number[] = []; // NK reads of the last minute, oldest first
const lastReadByIp = new Map<string, number>();

function remember(userId: string, entry: Entry) {
    cache.delete(userId);
    if (cache.size >= MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(userId, entry);
}

function globalWaitMs(now: number) {
    while (recentReads.length > 0 && now - recentReads[0]! >= 60_000) recentReads.shift();
    return recentReads.length < GLOBAL_PER_MINUTE ? 0 : 60_000 - (now - recentReads[0]!);
}

function ipWaitMs(ip: string, now: number) {
    const last = lastReadByIp.get(ip);
    return last === undefined ? 0 : Math.max(0, last + IP_COOLDOWN_MS - now);
}

function pruneIps(now: number) {
    if (lastReadByIp.size < 5000) return;
    for (const [ip, at] of lastReadByIp) if (now - at >= IP_COOLDOWN_MS) lastReadByIp.delete(ip);
}

function read(userId: string): Promise<Entry | null> {
    const running = inFlight.get(userId);
    if (running) return running;
    const job = fetchWithRetry<NkMatchesAnswer>(NK_API.PLAYER_MATCHES(userId), {
        priority: 'high',
        retries: 1,
    })
        .then((data) => {
            if (!data) return null;
            const entry = { data, fetchedAt: Date.now() };
            // a failed answer is kept too: retrying an unknown player wouldn't help
            remember(userId, entry);
            return entry;
        })
        .catch((error) => {
            logger.error(`Live matches of ${userId} failed: ${error}`);
            return null;
        })
        .finally(() => inFlight.delete(userId));
    inFlight.set(userId, job);
    return job;
}

export async function getLiveMatches(userId: string, ip: string): Promise<LiveMatchesResult> {
    const now = Date.now();
    const cached = cache.get(userId);
    if (cached && now - cached.fetchedAt < PLAYER_FRESH_MS) return { status: 'ok', entry: cached };

    // someone is already reading this player: share that read, it costs nothing more
    const running = inFlight.get(userId);
    if (running) {
        const entry = await running;
        return entry ? { status: 'ok', entry } : { status: 'unavailable' };
    }

    await loadCodeBook();
    if (playerCodeOf(userId) === undefined) return { status: 'unknown' };

    const wait = Math.max(globalWaitMs(now), ipWaitMs(ip, now));
    if (wait > 0) {
        return cached ? { status: 'ok', entry: cached } : { status: 'busy', retryAfterMs: wait };
    }

    recentReads.push(now);
    lastReadByIp.set(ip, now);
    pruneIps(now);
    const entry = await read(userId);
    if (entry) return { status: 'ok', entry };
    return cached ? { status: 'ok', entry: cached } : { status: 'unavailable' };
}
