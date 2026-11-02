/**
 * Delete stored matches played on maps that are never in Hall of Masters (NON_HOM_MAPS).
 * New matches on them are already skipped when saved; this cleans up what came in before.
 * bun run src/scripts/purgeNonHomMaps.ts [--season=46] [--dry-run]
 */
import mongoose from 'mongoose';
import { codeOf, loadCodeBook, namesOf } from '@/services/codeBook';
import connectDB from '@/services/database';
import { collection, isNonHomMap, listMatchSeasons, mapExpr } from '@/services/matchStore';

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value] = arg.replace(/^--/, '').split('=');
        return [key, value ?? 'true'];
    }),
);
const dryRun = args['dry-run'] === 'true';
const onlySeason = args.season !== undefined ? Number(args.season) : undefined;

await connectDB();
await loadCodeBook();

const maps = namesOf('map').filter(isNonHomMap);
const codes = maps.map((m) => codeOf('map', m)).filter((c): c is number => c !== undefined);
console.log(`Non-HoM map ids in the code book: ${maps.join(', ') || 'none'}`);

if (codes.length > 0) {
    const seasons = onlySeason !== undefined ? [onlySeason] : await listMatchSeasons();
    const filter = { $expr: { $in: [mapExpr, codes] } };
    let total = 0;
    for (const seasonId of seasons) {
        const n = dryRun
            ? await collection(seasonId).countDocuments(filter)
            : (await collection(seasonId).deleteMany(filter)).deletedCount;
        total += n;
        if (n > 0) {
            console.log(`Season ${seasonId}: ${n} match(es) ${dryRun ? 'to delete' : 'deleted'}`);
        }
    }
    console.log(`${dryRun ? 'Would delete' : 'Deleted'} ${total} match(es)`);
}

await mongoose.disconnect();
process.exit(0);
