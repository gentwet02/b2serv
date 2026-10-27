/**
 * Small in-memory caches for computed reads (head to head, comparisons, season records):
 * an answer is reused for `ttlMs`; past `max` entries the cache starts over.
 * Identical reads asked while one is being computed share it (a retry, two tabs, a refresh
 * don't start the same heavy work twice).
 */
export function createCache({ ttlMs = 5 * 60_000, max = 150 }: { ttlMs?: number; max?: number } = {}) {
    const entries = new Map<string, { data: unknown; expires: number }>();
    const pending = new Map<string, Promise<unknown>>();

    return async function cachedRead<T>(key: string, compute: () => Promise<T>): Promise<T> {
        const hit = entries.get(key);
        if (hit && hit.expires > Date.now()) return hit.data as T;
        const running = pending.get(key);
        if (running) return running as Promise<T>;

        const promise = compute()
            .then((data) => {
                if (entries.size >= max) entries.clear();
                entries.set(key, { data, expires: Date.now() + ttlMs });
                return data;
            })
            .finally(() => pending.delete(key));
        pending.set(key, promise);
        return promise;
    };
}

/** The shared cache: 5 minutes, 150 answers. */
export const cached = createCache();
