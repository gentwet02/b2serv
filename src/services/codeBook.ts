import mongoose from 'mongoose';
import { playerNames } from '@/data/playerNames';
import { logger } from '@/utils/logger';

/**
 * Number codes for everything a stored match refers to, kept in MongoDB.
 *
 * `codes`         { _id: "hero:Quincy_Cyber", c: 5 }   and counters { _id: "next:hero", c: 27 }
 * `player_codes`  { _id: 1234, u: "<NK user id>", n: "<display name>" }
 *
 * A name seen for the first time gets the next free number; a number is never reused
 * or changed. No hand-written list to keep in order, so a new hero, tower or map can't
 * shift the meaning of matches already stored (what corrupted the old `season<N>` data).
 */

export type CodeKind = 'hero' | 'tower' | 'map' | 'result';

/** Bits reserved for each kind in a packed match (see matchStore.ts). */
export const CODE_BITS: Record<CodeKind, number> = { hero: 7, tower: 6, map: 7, result: 3 };

interface CodeDoc {
    _id: string;
    c: number;
}

interface PlayerDoc {
    _id: number;
    u: string;
    n: string;
}

const codesCollection = () => mongoose.connection.collection<CodeDoc>('codes');
const playersCollection = () => mongoose.connection.collection<PlayerDoc>('player_codes');

const kinds: CodeKind[] = ['hero', 'tower', 'map', 'result'];
const byName = Object.fromEntries(kinds.map((k) => [k, new Map<string, number>()])) as Record<
    CodeKind,
    Map<string, number>
>;
const byCode = Object.fromEntries(kinds.map((k) => [k, new Map<number, string>()])) as Record<
    CodeKind,
    Map<number, string>
>;
const playerByUser = new Map<string, number>();
const playerByCode = new Map<number, { u: string; n: string }>();

let ready: Promise<void> | null = null;

/** Loads both dictionaries in memory (once). */
export function loadCodeBook(): Promise<void> {
    ready ??= (async () => {
        const [codes, players] = await Promise.all([
            codesCollection()
                .find({ _id: { $not: /^next:/ } })
                .toArray(),
            playersCollection().find({}).toArray(),
        ]);
        for (const { _id, c } of codes) {
            const [kind, ...rest] = _id.split(':');
            if (!kinds.includes(kind as CodeKind)) continue;
            const name = rest.join(':');
            byName[kind as CodeKind].set(name, c);
            byCode[kind as CodeKind].set(c, name);
        }
        for (const { _id, u, n } of players) {
            playerByUser.set(u, _id);
            playerByCode.set(_id, { u, n });
        }
        await playersCollection().createIndex({ u: 1 }, { unique: true });
        logger.debug(`Code book: ${codes.length} codes, ${players.length} players`);
    })().catch((error) => {
        ready = null;
        throw error;
    });
    return ready;
}

// one writer at a time, so two batches never hand out the same number
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
}

/** Reserves `count` consecutive numbers, returns the first one. */
async function reserve(counter: string, count: number): Promise<number> {
    const doc = await codesCollection().findOneAndUpdate(
        { _id: counter },
        { $inc: { c: count } },
        { upsert: true, returnDocument: 'after' },
    );
    if (!doc) throw new Error(`Counter ${counter} unavailable`);
    return doc.c - count;
}

const isDuplicateKey = (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: number }).code === 11000;

/** Makes sure every name has a code. */
export function ensureCodes(kind: CodeKind, names: Iterable<string>): Promise<void> {
    const missing = [...new Set(names)].filter((name) => name && !byName[kind].has(name));
    if (missing.length === 0) return Promise.resolve();

    return serialized(async () => {
        const still = missing.filter((name) => !byName[kind].has(name));
        if (still.length === 0) return;

        const first = await reserve(`next:${kind}`, still.length);
        const docs = still.map((name, i) => ({ _id: `${kind}:${name}`, c: first + i }));
        try {
            await codesCollection().insertMany(docs, { ordered: false });
        } catch (error) {
            if (!isDuplicateKey(error)) throw error;
            // another server process coded some of them first: use its numbers
            const existing = await codesCollection()
                .find({ _id: { $in: docs.map((d) => d._id) } })
                .toArray();
            docs.splice(0, docs.length, ...existing);
        }
        for (const { _id, c } of docs) {
            const name = _id.slice(kind.length + 1);
            byName[kind].set(name, c);
            byCode[kind].set(c, name);
            if (c >= 2 ** CODE_BITS[kind]) {
                logger.error(
                    `Code book: ${kind} "${name}" got code ${c}, past the ${CODE_BITS[kind]}-bit limit. ` +
                        `Matches using it are skipped until CODE_BITS.${kind} is raised (needs a new storage format).`,
                );
            } else {
                logger.info(`Code book: new ${kind} "${name}" = ${c}`);
            }
        }
    });
}

/** Makes sure every player has a code, and keeps display names current. */
export function ensurePlayers(
    entries: Iterable<[userId: string, displayName: string]>,
): Promise<void> {
    const latest = new Map<string, string>();
    for (const [userId, name] of entries) if (userId) latest.set(userId, name || 'Unknown player');

    const missing = [...latest.keys()].filter((u) => !playerByUser.has(u));
    const renamed = [...latest].filter(
        ([u, n]) => playerByUser.has(u) && playerByCode.get(playerByUser.get(u)!)?.n !== n,
    );
    if (missing.length === 0 && renamed.length === 0) return Promise.resolve();

    return serialized(async () => {
        const toAdd = missing.filter((u) => !playerByUser.has(u));
        if (toAdd.length > 0) {
            const first = await reserve('next:player', toAdd.length);
            const docs = toAdd.map((u, i) => ({ _id: first + i, u, n: latest.get(u)! }));
            try {
                await playersCollection().insertMany(docs, { ordered: false });
            } catch (error) {
                if (!isDuplicateKey(error)) throw error;
                const existing = await playersCollection()
                    .find({ u: { $in: toAdd } })
                    .toArray();
                docs.splice(0, docs.length, ...existing);
            }
            for (const { _id, u, n } of docs) {
                playerByUser.set(u, _id);
                playerByCode.set(_id, { u, n });
            }
        }
        if (renamed.length > 0) {
            await playersCollection().bulkWrite(
                renamed.map(([u, n]) => ({
                    updateOne: { filter: { u }, update: { $set: { n } } },
                })),
                { ordered: false },
            );
            for (const [u, n] of renamed) playerByCode.set(playerByUser.get(u)!, { u, n });
        }
    });
}

// ---------- lookups ----------

export const codeOf = (kind: CodeKind, name: string) => byName[kind].get(name);
export const nameOf = (kind: CodeKind, code: number) => byCode[kind].get(code) ?? 'Unknown';
export const namesOf = (kind: CodeKind) => [...byName[kind].keys()];
export const playerCodeOf = (userId: string) => playerByUser.get(userId);
export const playerOf = (code: number) => playerByCode.get(code);

export function findPlayerCodes(term: string): number[] {
    const needle = term.trim().toLowerCase();
    if (!needle) return [];
    const codes: number[] = [];
    for (const [code, { u, n }] of playerByCode) {
        if (n.toLowerCase().includes(needle) || playerNames[u]?.toLowerCase().includes(needle))
            codes.push(code);
    }
    return codes;
}
