/**
 * Records the names players had in past seasons (from the stored leaderboards) as older
 * names in player_codes, so the match history finds them by those names too.
 *   bun run src/scripts/backfillPlayerNames.ts [--dry-run]
 */
import mongoose from 'mongoose';
import connectDB from '@/services/database';
import { ensurePlayers, playerCodeOf, playerOf } from '@/services/codeBook';
import { loadAllStoredLeaderboards } from '@/services/leaderboardStore';
import { extractUserId } from '@/utils/helpers';

const dryRun = process.argv.includes('--dry-run');
await connectDB();

const seasons = await loadAllStoredLeaderboards();
const entries: [string, string][] = [];
const rows: Record<number, { players: number; oldNames: number }> = {};

for (const season of seasons.sort((a, b) => a.seasonId - b.seasonId)) {
    let oldNames = 0;
    for (const player of season.players) {
        const userId = extractUserId(player.profile);
        if (!userId || !player.displayName || player.displayName === 'Unknown player') continue;
        entries.push([userId, player.displayName]);
        const known = playerOf(playerCodeOf(userId) ?? -1);
        if (known && known.n !== player.displayName && !known.o?.includes(player.displayName))
            oldNames++;
    }
    rows[season.seasonId] = { players: season.players.length, oldNames };
}
console.table(rows);

if (dryRun) {
    console.log('Dry run: nothing written.');
} else {
    await ensurePlayers(entries, { rename: false });
    console.log('Older names recorded. Restart the server to load them.');
}
await mongoose.disconnect();
