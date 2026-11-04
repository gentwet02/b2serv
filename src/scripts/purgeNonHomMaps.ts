/**
 * Delete stored matches played on maps out of the Hall of Masters pool that season
 * (NON_HOM_MAPS always, HOM_MAP_REMOVED_SEASON from the season they left the pool).
 * Unfiltered seasons (UNFILTERED_SEASONS) are left as they are.
 * New matches on them are already skipped when saved; this cleans up what came in before.
 * bun run src/scripts/purgeNonHomMaps.ts [--season=46] [--dry-run]
 */
import mongoose from 'mongoose';
import { codeOf, findName, loadCodeBook, namesOf } from '@/services/codeBook';
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

const maps = namesOf('map');
const seasons = onlySeason !== undefined ? [onlySeason] : await listMatchSeasons();
let total = 0;
for (const seasonId of seasons) {
    const codes = maps
        .filter((m) => isNonHomMap(m, seasonId))
        .map((m) => codeOf('map', m))
        .filter((c): c is number => c !== undefined);
    for (const code of codes) {
        const filter = { $expr: { $eq: [mapExpr, code] } };
        const n = dryRun
            ? await collection(seasonId).countDocuments(filter)
            : (await collection(seasonId).deleteMany(filter)).deletedCount;
        total += n;
        if (n > 0) {
            console.log(
                `Season ${seasonId}, ${findName('map', code)}: ${n} match(es) ${dryRun ? 'to delete' : 'deleted'}`,
            );
        }
    }
}
console.log(`${dryRun ? 'Would delete' : 'Deleted'} ${total} match(es)`);

await mongoose.disconnect();
process.exit(0);
