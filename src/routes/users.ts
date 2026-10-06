import { Hono, type Context } from 'hono';
import { NK_API } from '@/config/constants';
import { fetchWithRetry } from '@/utils/helpers';
import { logger } from '@/utils/logger';

export const users = new Hono();

interface NkResponse {
    success: boolean;
    error: string | null;
    body?: unknown;
}

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
const USER_ID = /^[a-z0-9]{8,64}$/i;

const cache = new Map<string, { data: NkResponse; expires: number }>();
const inFlight = new Map<string, Promise<NkResponse | null>>();

function getCached(key: string, url: string): Promise<NkResponse | null> {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);

    // several tabs asking for the same player share one upstream request
    const running = inFlight.get(key);
    if (running) return running;

    const job = fetchWithRetry<NkResponse>(url)
        .then((data) => {
            if (data?.success) {
                if (cache.size >= MAX_ENTRIES) {
                    const oldest = cache.keys().next().value;
                    if (oldest !== undefined) cache.delete(oldest);
                }
                cache.set(key, { data, expires: Date.now() + TTL_MS });
            }
            return data;
        })
        .catch((error) => {
            logger.error(`Proxy ${key} failed: ${error}`);
            return null;
        })
        .finally(() => inFlight.delete(key));

    inFlight.set(key, job);
    return job;
}

function proxy(kind: 'profile' | 'matches') {
    return async (c: Context) => {
        const id = c.req.param('id') ?? '';
        if (!USER_ID.test(id)) {
            const message = 'Invalid user id';
            return c.json({ message, error: message }, 400);
        }

        const url = kind === 'profile' ? NK_API.PLAYER_PROFILE(id) : NK_API.PLAYER_MATCHES(id);
        const data = await getCached(`${kind}:${id}`, url);

        if (!data) {
            const message = "Ninja Kiwi's API didn't answer. Try again in a moment.";
            return c.json({ message, error: 'upstream_unavailable' }, 502);
        }
        if (!data.success) {
            const message = data.error || 'Player not found';
            return c.json({ message, error: message }, 404);
        }

        c.header('Cache-Control', 'public, max-age=60');
        return c.json(data);
    };
}

users.get('/:id/matches', proxy('matches'));
users.get('/:id', proxy('profile'));
