/**
 * Runs importMatches, importLeaderboards and importProfiles for every src/data/season_<N>
 * folder (matches.json, lb.json, players.json). N is the real season number; our season id is N - 1.
 *
 *   bun run src/scripts/importAll.ts [--from=31] [--to=46] [--only=matches|lb|players] [--dry-run] [--force]
 *
 * --force applies to leaderboards only (replace a season already stored as final).
 * Every step can be re-run safely: matches already stored are not duplicated.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = 'src/data';

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value] = arg.replace(/^--/, '').split('=');
        return [key, value ?? 'true'];
    }),
);
const from = Number(args.from ?? 0);
const to = Number(args.to ?? Infinity);
const only = args.only as 'matches' | 'lb' | 'players' | undefined;
const dryRun = args['dry-run'] === 'true';
const force = args.force === 'true';

const jobs = [
    {
        kind: 'matches',
        file: 'matches.json',
        script: 'src/scripts/importMatches.ts',
        extra: [] as string[],
    },
    {
        kind: 'lb',
        file: 'lb.json',
        script: 'src/scripts/importLeaderboards.ts',
        extra: force ? ['--force'] : [],
    },
    {
        // after the leaderboards: player codes get the season's names first
        kind: 'players',
        file: 'players.json',
        script: 'src/scripts/importProfiles.ts',
        extra: [] as string[],
    },
].filter((job) => !only || job.kind === only);

const folders = (await readdir(DATA_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, n: Number(entry.name.match(/^season_(\d+)$/)?.[1]) }))
    .filter((f) => Number.isInteger(f.n) && f.n >= from && f.n <= to)
    .sort((a, b) => a.n - b.n);

if (folders.length === 0) {
    console.error(`No season_<N> folders in ${DATA_DIR} for that range`);
    process.exit(1);
}
console.log(
    `Seasons ${folders.map((f) => f.n).join(', ')} | ${jobs.map((j) => j.kind).join(' + ')}` +
        `${dryRun ? ' | DRY RUN' : ''}${force ? ' | --force on leaderboards' : ''}`,
);

const summary: { season: number; id: number; kind: string; result: string; seconds: number }[] = [];

for (const folder of folders) {
    const id = folder.n - 1;
    for (const job of jobs) {
        const path = join(DATA_DIR, folder.name, job.file);
        if (!(await Bun.file(path).exists())) {
            summary.push({ season: folder.n, id, kind: job.kind, result: 'no file', seconds: 0 });
            continue;
        }
        console.log(`\n========== Season ${folder.n} (id ${id}) · ${job.kind} ==========`);
        const started = Date.now();
        const proc = Bun.spawn(
            [
                process.execPath,
                'run',
                job.script,
                `--file=${path}`,
                `--season=${id}`,
                ...(dryRun ? ['--dry-run'] : []),
                ...job.extra,
            ],
            { stdout: 'inherit', stderr: 'inherit' },
        );
        const code = await proc.exited;
        summary.push({
            season: folder.n,
            id,
            kind: job.kind,
            result: code === 0 ? 'ok' : `FAILED (exit ${code})`,
            seconds: Math.round((Date.now() - started) / 1000),
        });
    }
}

console.log('\n========== Summary ==========');
console.table(summary);
if (summary.some((s) => s.result.startsWith('FAILED'))) {
    console.log(
        'Re-run the failed ones with --from/--to/--only: everything already imported is skipped.',
    );
}
