import mongoose from 'mongoose';
import { COLLECTIONS } from '@/config/constants';
import { ensurePlayers, loadCodeBook, playerCodeOf, playerOf } from '@/services/codeBook';
import type { LeaderboardPlayer } from '@/types/leaderboard';
import { extractUserId } from '@/utils/helpers';
import { logger } from '@/utils/logger';

/**
 * Leaderboards: one document per season in `leaderboards`, packed.
 *
 *   count   number of players
 *   p       Binary  player codes (codeBook player_codes), uint32 LE, in rank order
 *   s       Binary  scores, int32 LE
 *   h       Binary  currentlyInHoM, 1 bit per player
 *   n       string  display names at that time, joined by \u001f
 *
 * About 8 bytes + the name per player.
 * Old documents (a `players` array) are still read and get rewritten on their next store.
 */

export interface StoredLeaderboard {
    seasonId: number;
    players: LeaderboardPlayer[];
    updatedAt: Date;
    final: boolean;
}

interface LeaderboardDoc {
    seasonId: number;
    updatedAt: Date;
    final: boolean;
    count?: number;
    p?: mongoose.mongo.Binary;
    s?: mongoose.mongo.Binary;
    h?: mongoose.mongo.Binary;
    n?: string;
    players?: LeaderboardPlayer[]; // old format
}

const SEP = '\u001f';
const profileUrl = (userId: string) => `https://data.ninjakiwi.com/battles2/users/${userId}`;
const collection = () => mongoose.connection.collection<LeaderboardDoc>(COLLECTIONS.LEADERBOARDS);

let indexed: Promise<unknown> | null = null;
const ensureIndex = () =>
    (indexed ??= collection()
        .createIndex({ seasonId: 1 }, { unique: true })
        .catch((error) => {
            indexed = null;
            logger.error(`Creating the leaderboards index failed: ${error}`);
        }));

function bytes(bin: mongoose.mongo.Binary): Buffer {
    const view = bin.buffer.subarray(0, bin.length());
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function encode(entry: StoredLeaderboard): LeaderboardDoc {
    const count = entry.players.length;
    const p = Buffer.alloc(count * 4);
    const s = Buffer.alloc(count * 4);
    const h = Buffer.alloc(Math.ceil(count / 8));
    const names: string[] = [];

    entry.players.forEach((player, i) => {
        const code = playerCodeOf(extractUserId(player.profile));
        if (code === undefined) throw new Error(`No player code for ${player.profile}`);
        p.writeUInt32LE(code, i * 4);
        s.writeInt32LE(Math.round(player.score), i * 4);
        if (player.currentlyInHoM) h[i >> 3] |= 1 << (i & 7);
        names.push((player.displayName ?? '').replaceAll(SEP, ' '));
    });

    const { Binary } = mongoose.mongo;
    return {
        seasonId: entry.seasonId,
        updatedAt: entry.updatedAt,
        final: entry.final,
        count,
        p: new Binary(p),
        s: new Binary(s),
        h: new Binary(h),
        n: names.join(SEP),
    };
}

function decode(doc: LeaderboardDoc): StoredLeaderboard {
    const base = {
        seasonId: doc.seasonId,
        updatedAt: new Date(doc.updatedAt),
        final: doc.final ?? false,
    };
    if (doc.players) return { ...base, players: doc.players };
    if (!doc.p || !doc.s || !doc.h) return { ...base, players: [] };

    const [p, s, h] = [bytes(doc.p), bytes(doc.s), bytes(doc.h)];
    const count = doc.count ?? p.length / 4;
    const names = doc.n ? doc.n.split(SEP) : [];
    const players: LeaderboardPlayer[] = [];
    let missing = 0;

    for (let i = 0; i < count; i++) {
        const player = playerOf(p.readUInt32LE(i * 4));
        if (!player) missing++;
        players.push({
            displayName: names[i] ?? player?.n ?? 'Unknown player',
            score: s.readInt32LE(i * 4),
            currentlyInHoM: (((h[i >> 3] ?? 0) >> (i & 7)) & 1) === 1,
            profile: profileUrl(player?.u ?? ''),
        });
    }
    if (missing > 0)
        logger.warn(`Leaderboard of season ${doc.seasonId}: ${missing} unknown player code(s)`);
    return { ...base, players };
}

export async function loadStoredLeaderboard(seasonId: number): Promise<StoredLeaderboard | null> {
    try {
        await loadCodeBook();
        const doc = await collection().findOne({ seasonId });
        return doc ? decode(doc) : null;
    } catch (error) {
        logger.error(`Loading stored leaderboard of season ${seasonId} failed: ${error}`);
        return null;
    }
}

/** renamePlayers: false for old data, so current names in player_codes aren't replaced by old ones */
export async function storeLeaderboard(
    entry: StoredLeaderboard,
    { renamePlayers = true }: { renamePlayers?: boolean } = {},
): Promise<boolean> {
    try {
        await loadCodeBook();
        await ensureIndex();
        await ensurePlayers(
            entry.players.map((p) => [extractUserId(p.profile), p.displayName]),
            { rename: renamePlayers },
        );
        await collection().updateOne(
            { seasonId: entry.seasonId },
            { $set: encode(entry), $unset: { players: '' } },
            { upsert: true },
        );
        return true;
    } catch (error) {
        logger.error(`Storing leaderboard of season ${entry.seasonId} failed: ${error}`);
        return false;
    }
}

/** Every season id with a stored leaderboard */
export async function listStoredSeasonIds(): Promise<number[]> {
    try {
        return (await collection().distinct('seasonId')) as number[];
    } catch (error) {
        logger.error(`Listing stored season ids failed: ${error}`);
        return [];
    }
}

/** Season ids already stored as final, to skip them when warming up */
export async function listFinalSeasonIds(): Promise<Set<number>> {
    try {
        const docs = await collection()
            .find({ final: true }, { projection: { seasonId: 1, _id: 0 } })
            .toArray();
        return new Set(docs.map((d) => d.seasonId));
    } catch (error) {
        logger.error(`Listing stored leaderboards failed: ${error}`);
        return new Set();
    }
}

/** Every stored season (for the rank history of players) */
export async function loadAllStoredLeaderboards(): Promise<StoredLeaderboard[]> {
    try {
        await loadCodeBook();
        const docs = await collection().find({}).toArray();
        return docs.map(decode);
    } catch (error) {
        logger.error(`Loading stored leaderboards failed: ${error}`);
        return [];
    }
}
