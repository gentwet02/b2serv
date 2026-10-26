import mongoose from 'mongoose';
import { NK_API } from '@/config/constants';
import { playerCodeOf, playerOf } from '@/services/codeBook';
import { assetKey, assetUrl } from '@/services/profileFormat';
import { fixAssetUrl } from '@/utils/assets';
import { fetchWithRetry } from '@/utils/helpers';
import { logger } from '@/utils/logger';

/**
 * Clans (NK calls them guilds): name, banner, tagline and size, kept in `clans`.
 * Read by the profile sweep for the clans of the players it reads, at most once a day each:
 * visitors never cause a request to Ninja Kiwi.
 */

export const CLANS_COLLECTION = 'clans';
/** a clan is read again once its last reading is this old */
const REFRESH_MS = 24 * 3600_000;
const CONCURRENCY = 2;

/** NK's guild answer, the fields we keep. */
interface NkGuildBody {
    name?: string;
    numMembers?: number;
    /** OPEN | FILTERED | CLOSED | DISBANDED */
    status?: string;
    tagline?: string;
    /** owner's profile link */
    owner?: string;
    banner?: string;
    bannerURL?: string;
}

interface ClanDoc {
    /** NK guild id */
    _id: string;
    /** name */
    n: string;
    /** banner asset key (profileFormat.assetKey) */
    b?: string;
    /** tagline */
    tg?: string;
    /** owner's NK user id */
    o?: string;
    /** members */
    m: number;
    /** status */
    s: string;
    /** when it was read */
    t: Date;
}

/** A clan as the API serves it. */
export interface Clan {
    id: string;
    name: string;
    bannerURL: string | null;
    tagline: string | null;
    members: number;
    status: string;
    ownerId: string | null;
    /** the owner's name, when they are a player we know */
    ownerName: string | null;
}

const collection = () => mongoose.connection.collection<ClanDoc>(CLANS_COLLECTION);
const memory = new Map<string, ClanDoc>();

const GUILD_ID = /\/guild\/([0-9a-f]{16,64})/i;
const USER_ID = /\/users\/([0-9a-f]{16,64})/i;

/** "https://data.ninjakiwi.com/battles2/guild/9fb9…" → "9fb9…" */
export const clanIdOf = (url: string | null | undefined) =>
    (url && GUILD_ID.exec(url)?.[1]) || null;

async function loadClans(ids: string[]): Promise<Map<string, ClanDoc>> {
    const found = new Map<string, ClanDoc>();
    const missing: string[] = [];
    for (const id of ids) {
        const hit = memory.get(id);
        if (hit) found.set(id, hit);
        else missing.push(id);
    }
    if (missing.length > 0) {
        for (const doc of await collection()
            .find({ _id: { $in: missing } })
            .toArray()) {
            memory.set(doc._id, doc);
            found.set(doc._id, doc);
        }
    }
    return found;
}

/** Needs the code book loaded (profileStore.getStoredProfile does it) for the owner's name. */
function toClan(doc: ClanDoc): Clan {
    const ownerCode = doc.o ? playerCodeOf(doc.o) : undefined;
    return {
        id: doc._id,
        name: doc.n,
        bannerURL: doc.b ? fixAssetUrl(assetUrl(doc.b)) : null,
        tagline: doc.tg ?? null,
        members: doc.m,
        status: doc.s,
        ownerId: doc.o ?? null,
        ownerName: (ownerCode !== undefined && playerOf(ownerCode)?.n) || null,
    };
}

/** A stored clan; null when we never read it or it was disbanded. */
export async function getClan(id: string): Promise<Clan | null> {
    const doc = (await loadClans([id])).get(id);
    return doc && doc.s !== 'DISBANDED' ? toClan(doc) : null;
}

/** Reads the clans we have no fresh reading of. A clan NK doesn't answer for is tried next time. */
export async function refreshClans(ids: Iterable<string>): Promise<{ read: number; failed: number }> {
    const all = [...new Set(ids)];
    if (all.length === 0) return { read: 0, failed: 0 };
    const known = await loadClans(all);
    const now = Date.now();
    const stale = all.filter((id) => {
        const doc = known.get(id);
        return !doc || now - new Date(doc.t).getTime() >= REFRESH_MS;
    });

    const docs: ClanDoc[] = [];
    let failed = 0;
    let index = 0;
    const worker = async () => {
        while (index < stale.length) {
            const id = stale[index++]!;
            const data = await fetchWithRetry<{ success?: boolean; body?: NkGuildBody }>(
                NK_API.GUILD(id),
                { priority: 'low', retries: 3 },
            );
            const body = data?.success ? data.body : undefined;
            if (!body || typeof body.name !== 'string') {
                failed++;
                continue;
            }
            const doc: ClanDoc = {
                _id: id,
                n: body.name,
                m: typeof body.numMembers === 'number' ? body.numMembers : 0,
                s: typeof body.status === 'string' ? body.status : 'UNKNOWN',
                t: new Date(),
            };
            if (body.bannerURL) doc.b = assetKey(body.bannerURL);
            if (body.tagline?.trim()) doc.tg = body.tagline.trim();
            const owner = body.owner && USER_ID.exec(body.owner)?.[1];
            if (owner) doc.o = owner;
            docs.push(doc);
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (docs.length > 0) {
        await collection().bulkWrite(
            docs.map((doc) => ({
                replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
            })),
            { ordered: false },
        );
        for (const doc of docs) memory.set(doc._id, doc);
    }
    if (stale.length > 0)
        logger.info(`Clans: ${docs.length}/${stale.length} read, ${failed} failed`);
    return { read: docs.length, failed };
}
