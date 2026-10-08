import { NK_API } from '@/config/constants';
import { loadStoredProfile, loadStoredProfiles, storeProfile } from '@/services/profileCache';
import { fixAssetUrl, learnProfileAssets } from '@/utils/assets';
import { fetchWithRetry, type Priority } from '@/utils/helpers';
import { logger } from '@/utils/logger';

/**
 * Player data from Ninja Kiwi, cached in memory and (profiles) in MongoDB.
 * A copy younger than FRESH_MS is served as is; an older one is served at once while a
 * fresh copy is fetched in the background. Only a player never seen before waits for NK.
 */

export interface NkResponse {
    success: boolean;
    error: string | null;
    body?: unknown;
}

export interface Entry {
    data: NkResponse;
    fetchedAt: number;
}

const FRESH_MS = 2 * 60_000;
const MAX_ENTRIES = 2000;
const avatarAttempts = new Map<string, number>();
const AVATAR_RETRY_MS = 10 * 60_000;
const memory = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Entry | null>>();

function remember(key: string, entry: Entry) {
    memory.delete(key); // re-insert so Map order tracks recency
    if (memory.size >= MAX_ENTRIES) {
        const oldest = memory.keys().next().value;
        if (oldest !== undefined) memory.delete(oldest);
    }
    memory.set(key, entry);
}

function fetchFresh(key: string, url: string, priority: Priority, persistId?: string) {
    const running = inFlight.get(key);
    if (running) return running;

    const job = fetchWithRetry<NkResponse>(url, { priority })
        .then(async (data) => {
            if (!data) return null;
            const entry = { data, fetchedAt: Date.now() };
            if (data.success) {
                learnProfileAssets(data);
                remember(key, entry);
                if (persistId) await storeProfile(persistId, data, new Date(entry.fetchedAt));
            }
            return entry;
        })
        .catch((error) => {
            logger.error(`Fetching ${key} failed: ${error}`);
            return null;
        })
        .finally(() => inFlight.delete(key));

    inFlight.set(key, job);
    return job;
}

export async function getPlayerData(
    kind: 'profile' | 'matches',
    id: string,
    missPriority: Priority = 'high',
): Promise<Entry | null> {
    const key = `${kind}:${id}`;
    const url = kind === 'profile' ? NK_API.PLAYER_PROFILE(id) : NK_API.PLAYER_MATCHES(id);
    const persistId = kind === 'profile' ? id : undefined;

    let hit = memory.get(key);
    if (!hit && persistId) {
        const stored = await loadStoredProfile(id);
        if (stored) {
            hit = {
                data: stored.data as NkResponse,
                fetchedAt: new Date(stored.fetchedAt).getTime(),
            };
            remember(key, hit);
        }
    }

    if (hit) {
        if (Date.now() - hit.fetchedAt > FRESH_MS) void fetchFresh(key, url, 'low', persistId);
        return hit;
    }
    return fetchFresh(key, url, missPriority, persistId);
}

/** Keeps these profiles fresh in the background (top of the leaderboard). */
export function warmProfiles(ids: string[]) {
    for (const id of ids) void getPlayerData('profile', id, 'low');
}

/** Avatar URL of each player whose profile we have (memory or MongoDB). No NK request. */
export async function getKnownAvatars(ids: string[]): Promise<Record<string, string>> {
    const avatars: Record<string, string> = {};
    const missing: string[] = [];
    for (const id of ids) {
        const body = memory.get(`profile:${id}`)?.data.body as
            | { equippedAvatarURL?: string }
            | undefined;
        if (body?.equippedAvatarURL) avatars[id] = fixAssetUrl(body.equippedAvatarURL);
        else missing.push(id);
    }
    for (const doc of await loadStoredProfiles(missing)) {
        const url = (doc.data as { body?: { equippedAvatarURL?: string } })?.body
            ?.equippedAvatarURL;
        if (url) avatars[doc._id] = fixAssetUrl(url);
    }
    return avatars;
}

/**
 * Avatars for the leaderboard rows a visitor is looking at.
 * Known ones come from memory or MongoDB; for the others a low-priority NK fetch is queued
 * (once per AVATAR_RETRY_MS per player), and their ids are returned as `pending`.
 */
export async function requestAvatars(ids: string[]) {
    const avatars = await getKnownAvatars(ids);
    const pending: string[] = [];
    const now = Date.now();

    for (const id of ids) {
        if (avatars[id]) continue;
        const key = `profile:${id}`;
        if (inFlight.has(key)) {
            pending.push(id);
            continue;
        }
        if (now - (avatarAttempts.get(id) ?? 0) < AVATAR_RETRY_MS) continue;
        avatarAttempts.set(id, now);
        // getKnownAvatars already looked in memory and MongoDB: go straight to NK
        void fetchFresh(key, NK_API.PLAYER_PROFILE(id), 'low', id);
        pending.push(id);
    }

    if (avatarAttempts.size > MAX_ENTRIES) {
        for (const [id, at] of avatarAttempts) {
            if (now - at >= AVATAR_RETRY_MS) avatarAttempts.delete(id);
        }
    }

    return { avatars, pending };
}
