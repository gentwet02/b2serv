import mongoose from 'mongoose';
import { COLLECTIONS } from '@/config/db';
import { findName, loadCodeBook, playerCodeOf, playerOf } from '@/services/codeBook';
import { storedGuildCode } from '@/services/profileFormat';
import type { NkUserId } from '@/types/ninjakiwi';
import type { StoredProfileDoc } from '@/types/profile';
import { logger } from '@/utils/logger';

/**
 * Who is in each clan, as far as the stored profiles say, kept in `clan_members`:
 *   { _id: "<clan id>", p: [player codes] }
 * A player counts for the clan of their latest reading, in all their games (the clans they
 * were in before aren't kept), and only the players we read profiles of are known: the HoM
 * ones.
 * Written as readings are stored (profileStore.storeReadings), by this server or the import
 * scripts, and mirrored in memory for the lookups. The collection is built from
 * `player_profiles` the first time (or by src/scripts/rebuildClanMembers.ts); what another
 * process writes later is seen at the next start.
 */

interface ClanMembersDoc {
    /** NK guild id */
    _id: string;
    /** player codes (player_codes) */
    p: number[];
}

const collection = () =>
    mongoose.connection.collection<ClanMembersDoc>(COLLECTIONS.CLAN_MEMBERS);
const profiles = () => mongoose.connection.collection<StoredProfileDoc>(COLLECTIONS.PROFILES);

/** clan id → its players' codes */
const members = new Map<string, Set<number>>();
/** player code → clan id */
const clanOfPlayer = new Map<number, string>();
/** clan id → times its members changed: answers cached about a clan are keyed with it */
const versions = new Map<string, number>();
let ready: Promise<void> | null = null;

const changed = (clanId: string) => versions.set(clanId, (versions.get(clanId) ?? 0) + 1);

/** The player's clan in memory; the clans whose members changed. */
function setClan(player: number, clanId: string | undefined): string[] {
    const previous = clanOfPlayer.get(player);
    if (previous === clanId) return [];
    const touched: string[] = [];
    if (previous !== undefined) {
        const left = members.get(previous);
        left?.delete(player);
        if (left?.size === 0) members.delete(previous);
        touched.push(previous);
    }
    if (clanId === undefined) {
        clanOfPlayer.delete(player);
    } else {
        clanOfPlayer.set(player, clanId);
        const joined = members.get(clanId) ?? new Set<number>();
        joined.add(player);
        members.set(clanId, joined);
        touched.push(clanId);
    }
    touched.forEach(changed);
    return touched;
}

/**
 * Builds `clan_members` again from every stored profile: each clan's document replaced,
 * the ones left without a known player removed.
 */
export async function rebuildClanMembers(): Promise<{ clans: number; players: number }> {
    await loadCodeBook();
    const found = new Map<number, string>();
    const cursor = profiles().find({}, { projection: { v: 1 }, batchSize: 5000 });
    for await (const stored of cursor) {
        const guild = storedGuildCode(stored);
        const clanId = guild === undefined ? undefined : findName('guild', guild);
        if (clanId) found.set(stored._id, clanId);
    }
    for (const player of [...clanOfPlayer.keys()]) {
        if (!found.has(player)) setClan(player, undefined);
    }
    for (const [player, clanId] of found) setClan(player, clanId);

    const ids = [...members.keys()];
    if (ids.length > 0) {
        await collection().bulkWrite(
            ids.map((id) => ({
                replaceOne: {
                    filter: { _id: id },
                    replacement: { _id: id, p: [...members.get(id)!] },
                    upsert: true,
                },
            })),
            { ordered: false },
        );
    }
    await collection().deleteMany({ _id: { $nin: ids } });
    logger.info(`Clan members rebuilt: ${clanOfPlayer.size} players in ${members.size} clans`);
    return { clans: members.size, players: clanOfPlayer.size };
}

/** Reads `clan_members` in memory (once); empty: builds it from the stored profiles. */
export function loadClanMembers(): Promise<void> {
    ready ??= (async () => {
        const docs = await collection().find({}).toArray();
        for (const doc of docs) {
            for (const player of doc.p) setClan(player, doc._id);
        }
        if (docs.length === 0) await rebuildClanMembers();
        else logger.debug(`Clan members: ${clanOfPlayer.size} players in ${members.size} clans`);
    })().catch((error) => {
        ready = null;
        throw error;
    });
    return ready;
}

/**
 * Profiles were stored: each player's clan now (undefined: none). Only the players whose
 * clan isn't the one we had are written.
 */
export async function setPlayerClans(entries: [player: number, clanId: string | undefined][]) {
    await loadClanMembers();
    const touched = new Set<string>();
    for (const [player, clanId] of entries) {
        for (const id of setClan(player, clanId)) touched.add(id);
    }
    if (touched.size === 0) return;
    await collection().bulkWrite(
        [...touched].map((id) => {
            const players = members.get(id);
            return players
                ? {
                      replaceOne: {
                          filter: { _id: id },
                          replacement: { _id: id, p: [...players] },
                          upsert: true,
                      },
                  }
                : { deleteOne: { filter: { _id: id } } };
        }),
        { ordered: false },
    );
}

/** The codes of the clan's known players. Needs loadClanMembers. */
export const clanMemberCodes = (clanId: string): number[] => [...(members.get(clanId) ?? [])];

/** The clan's known players. Needs loadClanMembers and the code book (loadCodeBook). */
export function clanMemberIds(clanId: string): NkUserId[] {
    const ids: NkUserId[] = [];
    for (const player of members.get(clanId) ?? []) {
        // player_codes ids come from NK's own links
        const userId = playerOf(player)?.u as NkUserId | undefined;
        if (userId) ids.push(userId);
    }
    return ids;
}

/** The clan of a player code (undefined: none we know). Needs loadClanMembers. */
export const clanIdOfPlayer = (player: number) => clanOfPlayer.get(player);

/** The clan of a player (undefined: none we know). Needs loadClanMembers and the code book. */
export function clanIdOfUser(userId: string) {
    const code = playerCodeOf(userId);
    return code === undefined ? undefined : clanOfPlayer.get(code);
}

/** Changes each time the clan's known members do (0: never since the server started). */
export const clanVersion = (clanId: string) => versions.get(clanId) ?? 0;

/** Every clan with a known player, and how many. Needs loadClanMembers. */
export function knownClans(): { id: string; known: number }[] {
    return [...members].map(([id, players]) => ({ id, known: players.size }));
}
