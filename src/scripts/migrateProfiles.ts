/**
 * Moves the old profile cache (`profiles`: raw NK answers, 14-day TTL) into player_profiles.
 *   bun run src/scripts/migrateProfiles.ts [--dry-run] [--drop]
 *
 * Each cached answer becomes one reading, filed under the season live when it was fetched.
 * --drop removes the old collection once everything is stored (nothing reads it any more).
 * Safe to re-run.
 */
import mongoose from 'mongoose';
import connectDB from '@/services/database';
import { fetchSeasons } from '@/services/ninjakiwi';
import { PROFILES_COLLECTION, storeReadings, type ProfileReading } from '@/services/profileStore';
import { seasonAt, toSeasonId } from '@/services/seasons';
import type { NkProfileBody } from '@/types/profile';

const dryRun = process.argv.includes('--dry-run');
const drop = process.argv.includes('--drop');
const OLD = 'profiles';
const BATCH = 500;

const seasons = (await fetchSeasons()).flatMap((s) => {
    const seasonId = toSeasonId(s);
    return seasonId === null ? [] : [{ seasonId, start: s.start }];
});
if (seasons.length === 0) {
    console.error("Couldn't fetch NK's season list, try again in a minute.");
    process.exit(1);
}

await connectDB();
const db = mongoose.connection.db!;
const old = db.collection<{ _id: string; data?: { body?: NkProfileBody }; fetchedAt?: Date }>(OLD);
const size = async (name: string) => {
    try {
        const stats = await db.command({ collStats: name });
        return `${(stats.size / 1024).toFixed(0)} KB (${stats.count} docs)`;
    } catch {
        return '-';
    }
};

console.log(
    `Before: ${OLD} ${await size(OLD)}, ${PROFILES_COLLECTION} ${await size(PROFILES_COLLECTION)}`,
);

let readings: ProfileReading[] = [];
const counts = { read: 0, stored: 0, skipped: 0 };
const perSeason = new Map<string, number>();

const flush = async () => {
    if (!dryRun && readings.length) counts.stored += (await storeReadings(readings)).readings;
    readings = [];
};

for await (const doc of old.find({})) {
    counts.read++;
    const body = doc.data?.body;
    if (!body?.rankedStats || !doc.fetchedAt) {
        counts.skipped++;
        continue;
    }
    const date = new Date(doc.fetchedAt);
    const seasonId = seasonAt(seasons, date.getTime());
    perSeason.set(String(seasonId ?? 'none'), (perSeason.get(String(seasonId ?? 'none')) ?? 0) + 1);
    readings.push({ userId: doc._id, body, date, seasonId });
    if (readings.length >= BATCH) await flush();
}
await flush();

console.log(dryRun ? '\nDRY RUN: nothing written' : '\nDone');
console.table(counts);
console.log('Readings per season:', Object.fromEntries(perSeason));
console.log(`After: ${PROFILES_COLLECTION} ${await size(PROFILES_COLLECTION)}`);

if (drop && !dryRun) {
    if (counts.stored + counts.skipped < counts.read) {
        console.error(`Not dropping ${OLD}: some profiles were not stored`);
    } else {
        await old.drop();
        console.log(`Dropped ${OLD}`);
    }
}
await mongoose.disconnect();
process.exit(0);
