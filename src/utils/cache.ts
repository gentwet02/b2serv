/**
 * A small in-memory cache for computed reads (head to head, comparisons, season records):
 * an answer is reused for 5 minutes; past 300 entries the cache starts over.
 */
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 300;
const entries = new Map<string, { data: unknown; expires: number }>();

export async function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = entries.get(key);
    if (hit && hit.expires > Date.now()) return hit.data as T;
    const data = await compute();
    if (entries.size > MAX_ENTRIES) entries.clear();
    entries.set(key, { data, expires: Date.now() + TTL_MS });
    return data;
}
