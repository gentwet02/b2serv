/**
 * Import final leaderboards from a dump of snapshots.
 *   bun run src/scripts/importLeaderboards.ts --file=<path> [--season=45] [--dry-run] [--force]
 *
 * Input: array of { date (unix s), season (NK key), lbsize, lb: [{ displayName, score, currentlyInHoM, profile }] }.
 * Keeps the latest snapshot of each season and stores it as its final leaderboard.
 * The live season is skipped (the server keeps it up to date). A season already stored
 * as final is only compared, unless --force.
 */
import mongoose from 'mongoose';
import connectDB from '@/services/database';
import { playerCodeOf } from '@/services/codeBook';
import { loadStoredLeaderboard, storeLeaderboard } from '@/services/leaderboardStore';
import { fetchSeasons } from '@/services/ninjakiwi';
import { toSeasonId } from '@/services/seasons';
import type { LeaderboardPlayer } from '@/types/leaderboard';
import { extractUserId } from '@/utils/helpers';
import { readJsonObjects } from '@/utils/readJsonObjects';

interface Snapshot {
    date?: number;
    season?: string;
    lbsize?: number;
    lb?: LeaderboardPlayer[];
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
const force = args.force === 'true';

if (!file || (expected !== undefined && !(Number.isInteger(expected) && expected > 0))) {
    console.error('Usage: --file=<path> [--season=<our season id>] [--dry-run] [--force]');
    process.exit(1);
}
if (!(await Bun.file(file).exists())) {
    console.error(`File not found: ${file}`);
    process.exit(1);
}

// ---------- NK seasons ----------

const toMs = (v: number) => (v < 1e12 ? v * 1000 : v);
const nkList = await fetchSeasons();
if (nkList.length === 0) {
    console.error("Couldn't fetch NK's season list, try again in a minute.");
    process.exit(1);
}
const byKey = new Map(
    nkList.flatMap((s) => {
        const seasonId = toSeasonId(s);
        return seasonId === null
            ? []
            : [[s.id, { seasonId, name: s.name, end: toMs(s.end), live: s.live }] as const];
    }),
);

// ---------- read: latest snapshot per season ----------

const latest = new Map<string, Required<Pick<Snapshot, 'date' | 'lb'>> & { lbsize?: number }>();
const snapshotCount = new Map<string, number>();
let malformed = 0;

for await (const raw of readJsonObjects(file)) {
    const snap = raw as Snapshot;
    if (!snap.season || !Array.isArray(snap.lb) || typeof snap.date !== 'number') {
        malformed++;
        continue;
    }
    snapshotCount.set(snap.season, (snapshotCount.get(snap.season) ?? 0) + 1);
    const best = latest.get(snap.season);
    if (!best || snap.date > best.date) {
        latest.set(snap.season, { date: snap.date, lb: snap.lb, lbsize: snap.lbsize });
    }
}

// ---------- check / store ----------

await connectDB();
const rows: Record<string, object> = {};

for (const [key, snap] of latest) {
    const ref = byKey.get(key);
    const seasonId = ref?.seasonId ?? expected;
    const label = `${seasonId ?? '?'} (${ref?.name ?? 'not in NK list'}, ${key})`;
    const skip = (action: string) => (rows[label] = { snapshots: snapshotCount.get(key), action });

    if (seasonId === undefined) {
        skip('skipped: unknown NK key (use --season)');
        continue;
    }
    if (expected !== undefined && ref && ref.seasonId !== expected) {
        skip(`skipped: not --season ${expected}`);
        continue;
    }
    if (ref?.live) {
        skip('skipped: live season');
        continue;
    }

    const players: LeaderboardPlayer[] = snap.lb
        .filter((p) => p && extractUserId(p.profile ?? '') && Number.isFinite(p.score))
        .map((p) => ({
            displayName: p.displayName ?? '',
            score: p.score,
            currentlyInHoM: Boolean(p.currentlyInHoM),
            profile: p.profile,
        }));
    const outOfOrder = players.filter((p, i) => i > 0 && p.score > players[i - 1]!.score).length;
    const newPlayers = new Set(
        players.map((p) => extractUserId(p.profile)).filter((u) => playerCodeOf(u) === undefined),
    ).size;
    const dateMs = snap.date * 1000;

    const stored = await loadStoredLeaderboard(seasonId);
    let differs: number | string = '-';
    if (stored && stored.players.length > 0) {
        const n = Math.max(stored.players.length, players.length);
        let diff = 0;
        for (let i = 0; i < n; i++) {
            const a = stored.players[i];
            const b = players[i];
            if (
                !a ||
                !b ||
                extractUserId(a.profile) !== extractUserId(b.profile) ||
                a.score !== b.score
            )
                diff++;
        }
        differs = diff;
    }

    let action: string;
    if (stored?.final && !force) action = 'kept: already stored as final (--force to replace)';
    else if (dryRun) action = stored ? 'would replace' : 'would store';
    else {
        const ok = await storeLeaderboard(
            { seasonId, players, updatedAt: new Date(dateMs), final: true },
            { renamePlayers: false },
        );
        action = ok ? (stored ? 'replaced' : 'stored') : 'FAILED (see log)';
    }

    rows[label] = {
        snapshots: snapshotCount.get(key),
        'last snapshot': new Date(dateMs).toISOString(),
        'after season end': ref ? dateMs >= ref.end : '?',
        players: players.length,
        'lbsize ok': snap.lbsize === undefined || snap.lbsize === snap.lb.length,
        'invalid entries': snap.lb.length - players.length,
        'out of order': outOfOrder,
        'new players': newPlayers,
        'stored before': stored ? `${stored.players.length}${stored.final ? ' (final)' : ''}` : '-',
        'rows differing': differs,
        action,
    };
}

console.log(dryRun ? '\nDRY RUN: DB and NK read, nothing written' : '\nDone');
console.table(rows);
if (malformed > 0) console.log(`${malformed} malformed snapshot(s) skipped`);
for (const [label, row] of Object.entries(rows)) {
    if ((row as Record<string, unknown>)['after season end'] === false) {
        console.warn(
            `⚠ ${label}: last snapshot is before the season end, so it may not be the final ranking`,
        );
    }
}
await mongoose.disconnect();
process.exit(0);
