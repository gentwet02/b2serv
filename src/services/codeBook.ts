import mongoose from 'mongoose';
import { playerNames } from '@/data/playerNames';
import { logger } from '@/utils/logger';

/**
 * Number codes for everything a stored match refers to, kept in MongoDB.
 *
 * `codes`         { _id: "hero:Quincy_Cyber", c: 5 }   and counters { _id: "next:hero", c: 27 }
 * `player_codes`  { _id: 1234, u: "<NK user id>", n: "<display name>", o: ["<older names>"] }
 *                 n is the latest name seen, o every other name the player had (searchable)
 *
 * A name seen for the first time gets the next free number; a number is never reused
 * or changed. No hand-written list to keep in order, so a new hero, tower or map can't
 * shift the meaning of matches already stored (what corrupted the old `season<N>` data).
 */

/** Kinds packed into a stored match: each has a fixed number of bits (CODE_BITS). */
export type MatchCodeKind = 'hero' | 'tower' | 'map' | 'result';
/**
 * Kinds used by stored profiles (profileStore.ts). No bit limit: they are stored as plain numbers.
 * `unit` is a profile's tower list (heroes included), kept apart from `tower` so it never
 * spends the 6 bits of the match towers.
 */
export type ProfileCodeKind =
    | 'avatar'
    | 'banner'
    | 'border'
    | 'title'
    | 'badge'
    | 'arena'
    | 'unit'
    | 'bloon'
    | 'accolade'
    | 'guild';
export type CodeKind = MatchCodeKind | ProfileCodeKind;

/** Bits reserved for each kind in a packed match (see matchStore.ts). */
export const CODE_BITS: Record<MatchCodeKind, number> = { hero: 7, tower: 6, map: 7, result: 3 };
const isMatchKind = (kind: CodeKind): kind is MatchCodeKind => kind in CODE_BITS;

interface CodeDoc {
    _id: string;
    c: number;
}

interface PlayerDoc {
    _id: number;
    u: string;
    n: string;
    o?: string[];
}

interface PlayerEntry {
    u: string;
    n: string;
    o?: string[];
}

const codesCollection = () => mongoose.connection.collection<CodeDoc>('codes');
const playersCollection = () => mongoose.connection.collection<PlayerDoc>('player_codes');

const kinds: CodeKind[] = [
    'hero',
    'tower',
    'map',
    'result',
    'avatar',
    'banner',
    'border',
    'title',
    'badge',
    'arena',
    'unit',
    'bloon',
    'accolade',
    'guild',
];
const byName = Object.fromEntries(kinds.map((k) => [k, new Map<string, number>()])) as Record<
    CodeKind,
    Map<string, number>
>;
const byCode = Object.fromEntries(kinds.map((k) => [k, new Map<number, string>()])) as Record<
    CodeKind,
    Map<number, string>
>;
const playerByUser = new Map<string, number>();
const playerByCode = new Map<number, PlayerEntry>();

let ready: Promise<void> | null = null;
let syncing: Promise<void> | null = null;
let lastSync = 0;
/** highest player code held in memory: player codes only grow, so newer ones are above it */
let maxPlayerCode = -1;

/** How often the server re-reads what other processes (import scripts) added. */
const SYNC_EVERY_MS = 60_000;

function addCode(_id: string, c: number) {
    const [kind, ...rest] = _id.split(':');
    if (!kinds.includes(kind as CodeKind)) return;
    const name = rest.join(':');
    byName[kind as CodeKind].set(name, c);
    byCode[kind as CodeKind].set(c, name);
}

function addPlayer({ _id, u, n, o }: PlayerDoc) {
    playerByUser.set(u, _id);
    playerByCode.set(_id, o?.length ? { u, n, o } : { u, n });
    if (_id > maxPlayerCode) maxPlayerCode = _id;
}

function syncCodeBook(): Promise<void> {
    syncing ??= (async () => {
        const [codes, players] = await Promise.all([
            codesCollection()
                .find({ _id: { $not: /^next:/ } })
                .toArray(),
            playersCollection()
                .find({ _id: { $gt: maxPlayerCode } })
                .toArray(),
        ]);
        for (const { _id, c } of codes) addCode(_id, c);
        for (const player of players) addPlayer(player);
        lastSync = Date.now();
        if (players.length > 0) logger.info(`Code book: ${players.length} new player(s) picked up`);
    })()
        .catch((error) => logger.error(`Code book sync failed: ${error}`))
        .finally(() => {
            syncing = null;
        });
    return syncing;
}

/** Loads both dictionaries in memory (once), then keeps them in step with the database. */
export async function loadCodeBook(): Promise<void> {
    ready ??= (async () => {
        const [codes, players] = await Promise.all([
            codesCollection()
                .find({ _id: { $not: /^next:/ } })
                .toArray(),
            playersCollection().find({}).toArray(),
        ]);
        for (const { _id, c } of codes) addCode(_id, c);
        for (const player of players) addPlayer(player);
        lastSync = Date.now();
        await playersCollection().createIndex({ u: 1 }, { unique: true });
        logger.debug(`Code book: ${codes.length} codes, ${players.length} players`);
    })().catch((error) => {
        ready = null;
        throw error;
    });
    await ready;
    if (Date.now() - lastSync > SYNC_EVERY_MS) await syncCodeBook();
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
            if (isMatchKind(kind) && c >= 2 ** CODE_BITS[kind]) {
                logger.error(
                    `Code book: ${kind} "${name}" got code ${c}, past the ${CODE_BITS[kind]}-bit limit. ` +
                        `Matches using it are skipped until CODE_BITS.${kind} is raised (needs a new storage format).`,
                );
            } else if (isMatchKind(kind)) {
                logger.info(`Code book: new ${kind} "${name}" = ${c}`);
            } else {
                logger.debug(`Code book: new ${kind} "${name}" = ${c}`);
            }
        }
    });
}

/** true when `name` is neither the player's current name nor one of their older ones */
const isNewName = (player: PlayerEntry, name: string) =>
    player.n !== name && !(player.o ?? []).includes(name);

/**
 * Makes sure every player has a code, and keeps every name they went by.
 *  rename: true   live data: the name becomes current, the previous one is kept in `o`
 *  rename: false  old data: the current name stays, the old one is added to `o`
 */
export function ensurePlayers(
    entries: Iterable<[userId: string, displayName: string]>,
    { rename = true }: { rename?: boolean } = {},
): Promise<void> {
    // every distinct name per player (old data can list several for one season)
    const seen = new Map<string, string[]>();
    for (const [userId, name] of entries) {
        if (!userId) continue;
        const names = seen.get(userId) ?? [];
        const clean = name || 'Unknown player';
        if (!names.includes(clean)) names.push(clean);
        seen.set(userId, names);
    }

    const changed = (u: string) => {
        const player = playerOf(playerByUser.get(u)!);
        return !!player && seen.get(u)!.some((name) => isNewName(player, name));
    };
    const missing = [...seen.keys()].filter((u) => !playerByUser.has(u));
    const known = [...seen.keys()].filter((u) => playerByUser.has(u) && changed(u));
    if (missing.length === 0 && known.length === 0) return Promise.resolve();

    return serialized(async () => {
        const toAdd = missing.filter((u) => !playerByUser.has(u));
        if (toAdd.length > 0) {
            const first = await reserve('next:player', toAdd.length);
            const docs: PlayerDoc[] = toAdd.map((u, i) => {
                const names = seen.get(u)!;
                const n = rename ? names.at(-1)! : names[0]!;
                const o = names.filter((name) => name !== n);
                return o.length ? { _id: first + i, u, n, o } : { _id: first + i, u, n };
            });
            try {
                await playersCollection().insertMany(docs, { ordered: false });
            } catch (error) {
                if (!isDuplicateKey(error)) throw error;
                const existing = await playersCollection()
                    .find({ u: { $in: toAdd } })
                    .toArray();
                docs.splice(0, docs.length, ...existing);
            }
            for (const doc of docs) addPlayer(doc);
        }

        const updates: { u: string; set?: string; add: string[] }[] = [];
        for (const u of known) {
            const code = playerByUser.get(u)!;
            const player = playerOf(code);
            if (!player) continue;
            const fresh = seen.get(u)!.filter((name) => isNewName(player, name));
            if (fresh.length === 0) continue;
            if (rename) {
                const n = fresh.at(-1)!;
                const add = [player.n, ...fresh.filter((name) => name !== n)];
                updates.push({ u, set: n, add });
            } else {
                updates.push({ u, add: fresh });
            }
        }
        if (updates.length === 0) return;

        await playersCollection().bulkWrite(
            updates.map(({ u, set, add }) => ({
                updateOne: {
                    filter: { u },
                    update: {
                        ...(set !== undefined && { $set: { n: set } }),
                        $addToSet: { o: { $each: add } },
                    },
                },
            })),
            { ordered: false },
        );
        for (const { u, set, add } of updates) {
            const code = playerByUser.get(u)!;
            const player = playerOf(code)!;
            const n = set ?? player.n;
            const o = [...new Set([...(player.o ?? []), ...add])].filter((name) => name !== n);
            playerByCode.set(code, o.length ? { u, n, o } : { u, n });
        }
    });
}

// ---------- lookups ----------

export const codeOf = (kind: CodeKind, name: string) => byName[kind].get(name);
export const nameOf = (kind: CodeKind, code: number) => byCode[kind].get(code) ?? 'Unknown';
/** like nameOf, but undefined for a code we don't know */
export const findName = (kind: CodeKind, code: number) => byCode[kind].get(code);
export const namesOf = (kind: CodeKind) => [...byName[kind].keys()];
export const playerCodeOf = (userId: string) => playerByUser.get(userId);
export const playerOf = (code: number) => playerByCode.get(code);

const nameHit = (needle: string) => (name: string | undefined) =>
    !!name && name.toLowerCase().includes(needle);

/**
 * Players whose id, current name or alias contains `term`.
 * allNames: also the names they went by before (player_codes `o`).
 */
export function findPlayerCodes(term: string, { allNames = false } = {}): number[] {
    const raw = term.trim();
    const needle = raw.toLowerCase();
    if (!needle) return [];
    const codes = new Set<number>();

    const byId = playerByUser.get(raw) ?? playerByUser.get(needle);
    if (byId !== undefined) codes.add(byId);

    const hit = nameHit(needle);
    for (const [code, { u, n, o }] of playerByCode) {
        if (hit(n) || hit(playerNames[u]) || (allNames && o?.some(hit))) codes.add(code);
    }
    return [...codes];
}

/**
 * The older name of a player that `term` found, when it found them only through it
 * (not by id, current name or alias). undefined otherwise.
 */
export function matchedOldName(code: number, term: string): string | undefined {
    const player = playerByCode.get(code);
    const needle = term.trim().toLowerCase();
    if (!player || !needle) return undefined;
    const hit = nameHit(needle);
    if (player.u === term.trim() || player.u === needle) return undefined;
    if (hit(player.n) || hit(playerNames[player.u])) return undefined;
    return player.o?.find(hit);
}
