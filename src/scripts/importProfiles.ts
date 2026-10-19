/**
 * Import old profile snapshots into player_profiles.
 *   bun run src/scripts/importProfiles.ts --file=<path> [--season=45] [--dry-run]
 *
 * Input: JSON array (or JSON lines) of
 *   { plid: "<NK profile link>", date: <unix s>, season: "<NK season key>", body: <NK profile body>, … }
 * Each snapshot is filed under its season: NK's key → our id when NK still lists the key,
 * otherwise --season (NK doesn't list old seasons, so old dumps rely on it; importAll passes
 * it from the season_<N> folder name). Readings are applied oldest first; a season keeps its first and last
 * snapshot, the current profile only moves forward in time, and names from old data never
 * replace a player's current one. Safe to re-run: the same snapshot gives the same result.
 * "same season" column: share of bodies whose own `currentSeason` is the season they're filed
 * under, a check of the NK key → season id mapping (players who hadn't played the season yet
 * still show the previous one).
 */
import mongoose from 'mongoose';
import connectDB from '@/services/database';
import { playerCodeOf } from '@/services/codeBook';
import { fetchSeasons } from '@/services/ninjakiwi';
import { storeReadings, type ProfileReading } from '@/services/profileStore';
import { toMs, toSeasonId } from '@/services/seasons';
import type { NkProfileBody } from '@/types/profile';
import { extractUserId } from '@/utils/helpers';
import { readJsonObjects } from '@/utils/readJsonObjects';

interface Snapshot {
    plid?: string;
    date?: number;
    season?: string;
    body?: NkProfileBody;
}

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value] = arg.replace(/^--/, '').split('=');
        return [key, value ?? 'true'];
    }),
);
const file = args.file;
const expected = args.season !== undefined ? Number(args.season) : undefined;
const dryRun = args['dry-run'] === 'true';
const BATCH = 500;

if (!file || (expected !== undefined && !(Number.isInteger(expected) && expected >= 0))) {
    console.error('Usage: --file=<path> [--season=<our season id>] [--dry-run]');
    process.exit(1);
}
if (!(await Bun.file(file).exists())) {
    console.error(`File not found: ${file}`);
    process.exit(1);
}

const nkList = await fetchSeasons();
if (nkList.length === 0) console.warn("⚠ Couldn't fetch NK's season list: only --season is used");
const byKey = new Map(
    nkList.flatMap((s) => {
        const seasonId = toSeasonId(s);
        return seasonId === null
            ? []
            : [[s.id, { seasonId, live: s.live, end: toMs(s.end) }] as const];
    }),
);

// ---------- read ----------

interface SeasonRow {
    snapshots: number;
    players: Set<string>;
    first: number;
    last: number;
    /** NK's own `currentSeason` in the bodies, to check the season mapping */
    nkSeasons: Map<string, number>;
    action?: string;
}
const perSeason = new Map<number, SeasonRow>();
const skipped = { malformed: 0, unknownSeason: 0, otherSeason: 0, liveSeason: 0 };
const readings: ProfileReading[] = [];

for await (const raw of readJsonObjects(file)) {
    const snap = raw as Snapshot;
    const userId = snap.plid ? extractUserId(snap.plid) : '';
    if (
        !/^[a-z0-9]{8,64}$/i.test(userId) ||
        typeof snap.date !== 'number' ||
        !snap.body?.rankedStats
    ) {
        skipped.malformed++;
        continue;
    }
    const ref = snap.season ? byKey.get(snap.season) : undefined;
    const seasonId = ref?.seasonId ?? expected;
    if (seasonId === undefined) {
        skipped.unknownSeason++;
        continue;
    }
    if (expected !== undefined && ref && ref.seasonId !== expected) {
        skipped.otherSeason++;
        continue;
    }
    if (ref?.live) {
        skipped.liveSeason++; // the sweep takes care of the live season
        continue;
    }
    const dateMs = toMs(snap.date);
    readings.push({ userId, body: snap.body, date: new Date(dateMs), seasonId });

    const row = perSeason.get(seasonId) ?? {
        snapshots: 0,
        players: new Set<string>(),
        first: Infinity,
        last: -Infinity,
        nkSeasons: new Map<string, number>(),
    };
    row.snapshots++;
    row.players.add(userId);
    row.first = Math.min(row.first, dateMs);
    row.last = Math.max(row.last, dateMs);
    const nk = String(snap.body.currentSeason ?? 'none');
    row.nkSeasons.set(nk, (row.nkSeasons.get(nk) ?? 0) + 1);
    perSeason.set(seasonId, row);
}

// ---------- store ----------

await connectDB();
let stored = 0;
if (!dryRun) {
    for (let i = 0; i < readings.length; i += BATCH) {
        const saved = await storeReadings(readings.slice(i, i + BATCH), { rename: false });
        stored += saved.readings;
        process.stdout.write(`\rStored ${stored}/${readings.length} snapshot(s)`);
    }
    if (readings.length) process.stdout.write('\n');
}

const rows: Record<string, object> = {};
for (const [seasonId, row] of [...perSeason].sort(([a], [b]) => a - b)) {
    const nk = [...row.nkSeasons].sort((a, b) => b[1] - a[1]);
    const matching = row.nkSeasons.get(`season_${seasonId}`) ?? 0;
    rows[`season id ${seasonId}`] = {
        snapshots: row.snapshots,
        players: row.players.size,
        'new players': [...row.players].filter((u) => playerCodeOf(u) === undefined).length,
        from: new Date(row.first).toISOString().slice(0, 16),
        to: new Date(row.last).toISOString().slice(0, 16),
        'NK currentSeason': nk
            .slice(0, 3)
            .map(([k, n]) => `${k}×${n}`)
            .join(' '),
        'same season': `${Math.round((matching / row.snapshots) * 100)}%`,
        action: dryRun ? 'would store' : 'stored',
    };
}

console.log(dryRun ? '\nDRY RUN: nothing written' : '\nDone');
console.table(rows);
const notes = Object.entries(skipped).filter(([, n]) => n > 0);
if (notes.length) console.log(`Skipped: ${notes.map(([k, n]) => `${n} ${k}`).join(', ')}`);
if (skipped.unknownSeason > 0) {
    console.warn(
        `⚠ ${skipped.unknownSeason} snapshot(s) have a season key NK doesn't list (old seasons): ` +
            'give the season with --season=<our season id> (importAll does it from the folder name)',
    );
}
for (const [seasonId, row] of perSeason) {
    const matching = row.nkSeasons.get(`season_${seasonId}`) ?? 0;
    if (matching < row.snapshots / 2) {
        console.warn(
            `⚠ season id ${seasonId}: most bodies say another NK season (${[...row.nkSeasons.keys()].join(', ')}). ` +
                `Check the season mapping before importing.`,
        );
    }
}
await mongoose.disconnect();
process.exit(0);
