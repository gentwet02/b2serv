import mongoose from 'mongoose';
import {
    ensureCodes,
    ensurePlayers,
    findName,
    codeOf,
    loadCodeBook,
    namesOf,
    playerCodeOf,
    playerOf,
    type ProfileCodeKind,
} from '@/services/codeBook';
import {
    applyReading,
    assetUrl,
    avatarOf,
    decodeProfile,
    decodeSeasons,
    pack,
    profileNames,
    unpack,
    type Codec,
} from '@/services/profileFormat';
import type { NkProfileBody, ProfileDoc, StoredProfileDoc } from '@/types/profile';
import { logger } from '@/utils/logger';

/**
 * Player profiles, kept for good in `player_profiles` (format: profileFormat.ts).
 * Written by the profile sweep and the import scripts only: visitors never cause a request
 * to Ninja Kiwi, they get what is stored here.
 */

export const PROFILES_COLLECTION = 'player_profiles';
const collection = () => mongoose.connection.collection<StoredProfileDoc>(PROFILES_COLLECTION);

export const codec: Codec = {
    code(kind, name) {
        const code = codeOf(kind, name);
        if (code === undefined) throw new Error(`No code for ${kind} "${name}"`);
        return code;
    },
    name: (kind, code) => findName(kind, code),
};

/** Decoded documents, by player code. Small: one entry is a few hundred bytes. */
const MAX_CACHED = 5000;
const memory = new Map<number, ProfileDoc>();
function remember(doc: ProfileDoc) {
    memory.delete(doc._id);
    if (memory.size >= MAX_CACHED) {
        const oldest = memory.keys().next().value;
        if (oldest !== undefined) memory.delete(oldest);
    }
    memory.set(doc._id, doc);
}

async function loadDocs(codes: number[]): Promise<Map<number, ProfileDoc>> {
    const found = new Map<number, ProfileDoc>();
    const missing: number[] = [];
    for (const code of codes) {
        const hit = memory.get(code);
        if (hit) found.set(code, hit);
        else missing.push(code);
    }
    if (missing.length > 0) {
        const docs = await collection()
            .find({ _id: { $in: missing } })
            .toArray();
        for (const stored of docs) {
            try {
                const doc = unpack(stored);
                remember(doc);
                found.set(doc._id, doc);
            } catch (error) {
                logger.error(`Reading stored profile ${stored._id} failed: ${error}`);
            }
        }
    }
    return found;
}

export interface ProfileReading {
    userId: string;
    body: NkProfileBody;
    date: Date;
    /** season the reading counts for (seasons.seasonAt), null for none */
    seasonId: number | null;
}

/**
 * Stores readings (any order, several per player allowed).
 * rename: false for old data, so it never replaces a player's current name.
 */
export async function storeReadings(
    readings: ProfileReading[],
    { rename = true }: { rename?: boolean } = {},
): Promise<{ players: number; readings: number }> {
    if (readings.length === 0) return { players: 0, readings: 0 };
    await loadCodeBook();

    // oldest first: name history and streak comparisons follow time
    const sorted = [...readings].sort((a, b) => a.date.getTime() - b.date.getTime());
    await ensurePlayers(
        sorted.map((r) => [r.userId, r.body.displayName ?? ''] as [string, string]),
        { rename },
    );

    const names = new Map<ProfileCodeKind, Set<string>>();
    for (const { body } of sorted) {
        for (const [kind, set] of profileNames(body)) {
            const all = names.get(kind) ?? new Set<string>();
            for (const name of set) all.add(name);
            names.set(kind, all);
        }
    }
    for (const [kind, set] of names) await ensureCodes(kind, set);

    const codes = [...new Set(sorted.map((r) => playerCodeOf(r.userId)!))];
    const docs = await loadDocs(codes);
    const changed = new Set<number>();
    for (const reading of sorted) {
        const code = playerCodeOf(reading.userId);
        if (code === undefined) continue;
        try {
            docs.set(code, applyReading(docs.get(code) ?? null, code, reading, codec));
            changed.add(code);
        } catch (error) {
            logger.error(`Profile reading of ${reading.userId} skipped: ${error}`);
        }
    }

    const ops = [...changed].map((code) => {
        const stored = pack(docs.get(code)!);
        return { replaceOne: { filter: { _id: code }, replacement: stored, upsert: true } };
    });
    if (ops.length > 0) await collection().bulkWrite(ops, { ordered: false });
    // keep the cache equal to what was stored (dates are kept to the minute)
    for (const code of changed) memory.delete(code);
    return { players: changed.size, readings: sorted.length };
}

/** A player's stored profile, as the NK body the client reads plus our season records. */
export async function getStoredProfile(userId: string) {
    await loadCodeBook();
    const code = playerCodeOf(userId);
    if (code === undefined) return null;
    const doc = (await loadDocs([code])).get(code);
    if (!doc) return null;
    const name = playerOf(code)?.n ?? 'Unknown player';
    return { body: decodeProfile(doc, name, codec), fetchedAt: doc.t };
}

/** One season record of a player, from the stored profile. */
export async function getProfileSeason(userId: string, seasonId: number) {
    await loadCodeBook();
    const code = playerCodeOf(userId);
    if (code === undefined) return null;
    const doc = (await loadDocs([code])).get(code);
    if (!doc || !doc.s.some((s) => s.i === seasonId)) return null;
    return decodeSeasons(doc, codec).find((s) => s.seasonId === seasonId) ?? null;
}

/** Avatar link of each stored player (players without a stored profile are left out). */
export async function getStoredAvatars(userIds: string[]): Promise<Record<string, string>> {
    await loadCodeBook();
    const byCode = new Map<number, string>();
    for (const id of userIds) {
        const code = playerCodeOf(id);
        if (code !== undefined) byCode.set(code, id);
    }
    const avatars: Record<string, string> = {};
    if (byCode.size === 0) return avatars;
    try {
        const docs = await loadDocs([...byCode.keys()]);
        for (const [code, doc] of docs) {
            const url = avatarOf(doc, codec);
            if (url) avatars[byCode.get(code)!] = url;
        }
    } catch (error) {
        logger.error(`Loading stored avatars failed: ${error}`);
    }
    return avatars;
}

/** When each of these players was last read (missing: never). */
export async function lastReadTimes(userIds: string[]): Promise<Map<string, number>> {
    await loadCodeBook();
    const byCode = new Map<number, string>();
    for (const id of userIds) {
        const code = playerCodeOf(id);
        if (code !== undefined) byCode.set(code, id);
    }
    const times = new Map<string, number>();
    if (byCode.size === 0) return times;
    const docs = await collection()
        .find({ _id: { $in: [...byCode.keys()] } }, { projection: { t: 1 } })
        .toArray();
    for (const doc of docs) times.set(byCode.get(doc._id)!, new Date(doc.t).getTime());
    return times;
}

/** Every avatar, banner and border link we have a code for (to learn the static twins). */
export async function listProfileAssetUrls(): Promise<string[]> {
    await loadCodeBook();
    return (['avatar', 'banner', 'border'] as const).flatMap((kind) => namesOf(kind).map(assetUrl));
}

export async function countStoredProfiles(): Promise<number> {
    return collection().estimatedDocumentCount();
}
