/**
 * Rewrites leaderboards still in the old format (a `players` array) in the packed format.
 *   bun run src/scripts/migrateLeaderboards.ts [--dry-run]
 */
import mongoose from 'mongoose';
import { COLLECTIONS } from '@/config/constants';
import connectDB from '@/services/database';
import { storeLeaderboard } from '@/services/leaderboardStore';
import type { LeaderboardPlayer } from '@/types/leaderboard';

const dryRun = process.argv.includes('--dry-run');
await connectDB();

const raw = mongoose.connection.collection(COLLECTIONS.LEADERBOARDS);
const size = (doc: object) => mongoose.mongo.BSON.calculateObjectSize(doc);
const legacy = await raw.find({ players: { $exists: true } }).toArray();
const rows: Record<string, object> = {};
let [before, after] = [0, 0];

for (const doc of legacy) {
    const bytesBefore = size(doc);
    before += bytesBefore;
    const row: Record<string, unknown> = {
        players: doc.players.length,
        before: `${(bytesBefore / 1024).toFixed(1)} KB`,
    };
    if (!dryRun) {
        const ok = await storeLeaderboard(
            {
                seasonId: doc.seasonId,
                players: doc.players as LeaderboardPlayer[],
                updatedAt: new Date(doc.updatedAt),
                final: doc.final ?? false,
            },
            { renamePlayers: false },
        );
        const fresh = ok ? await raw.findOne({ seasonId: doc.seasonId }) : null;
        const bytesAfter = fresh ? size(fresh) : 0;
        after += bytesAfter;
        row.after = ok ? `${(bytesAfter / 1024).toFixed(1)} KB` : 'FAILED';
    }
    rows[`season ${doc.seasonId}`] = row;
}

console.log(dryRun ? 'DRY RUN, nothing written' : 'Done');
console.table(rows);
console.log(
    `${legacy.length} leaderboard(s): ${(before / 1024).toFixed(0)} KB` +
        (dryRun ? '' : ` → ${(after / 1024).toFixed(0)} KB`),
);
await mongoose.disconnect();
process.exit(0);
