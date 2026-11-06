/**
 * Unpacks dataexport-<N>[-anything].zip files (dataexport/{matches,players,lb}.json inside, N the
 * season number as shown) into the <data>/season_<N>/ folders the other scripts read.
 *   bun run src/scripts/unpackExports.ts [--data=src/data] [--from=46] [--to=48] [--force]
 * --from / --to: season numbers as shown, like importAll.
 * --clean removes the season_<N>/ folders instead, once imported: only those whose zip is still
 * there, so nothing is lost.
 * A season folder that already exists is left as it is, unless --force.
 * Needs the `unzip` command (sudo apt install unzip).
 */
import { mkdir, readdir, rm } from 'node:fs/promises';

const EXPORT_ZIP = /^dataexport-(\d+)(?:-[^/]*)?\.zip$/;
const EXPORT_FILES = ['matches.json', 'players.json', 'lb.json'];

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value] = arg.replace(/^--/, '').split('=');
        return [key, value ?? 'true'];
    }),
);
const dataDir = (args.data ?? 'src/data').replace(/\/$/, '');
const force = args.force === 'true';
const clean = args.clean === 'true';
const from = Number(args.from ?? 0);
const to = Number(args.to ?? Infinity);

if (!clean && !Bun.which('unzip')) {
    console.error('The unzip command is missing: sudo apt install unzip');
    process.exit(1);
}

const zips = (await readdir(dataDir))
    .map((name) => ({ name, n: Number(name.match(EXPORT_ZIP)?.[1]) }))
    .filter((zip) => Number.isInteger(zip.n) && zip.n > 0 && zip.n >= from && zip.n <= to)
    .sort((a, b) => a.n - b.n);
if (zips.length === 0) {
    console.error(`No dataexport-<N>.zip in ${dataDir} for that range`);
    process.exit(1);
}
const seasons = zips.map((zip) => zip.n);
const twice = seasons.filter((n, i) => seasons.indexOf(n) !== i);
if (twice.length > 0) {
    console.error(`Several zips for season(s) ${[...new Set(twice)].join(', ')}: keep one each`);
    process.exit(1);
}

const summary: Record<string, { folder: string; result: string }> = {};
for (const zip of zips) {
    const folder = `${dataDir}/season_${zip.n}`;
    if (clean) {
        const there = (await readdir(dataDir)).includes(`season_${zip.n}`);
        if (there) await rm(folder, { recursive: true, force: true });
        summary[zip.name] = { folder, result: there ? 'removed' : 'no folder' };
        continue;
    }
    const exists = await Bun.file(`${folder}/matches.json`).exists();
    if (exists && !force) {
        summary[zip.name] = { folder, result: 'already there (--force to replace)' };
        continue;
    }
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    // -j drops the dataexport/ folder: the files land straight in season_<N>/
    const proc = Bun.spawn(
        [
            'unzip',
            '-o',
            '-j',
            '-q',
            `${dataDir}/${zip.name}`,
            ...EXPORT_FILES.map((file) => `*/${file}`),
            '-d',
            folder,
        ],
        { stdout: 'inherit', stderr: 'inherit' },
    );
    const code = await proc.exited;
    const missing: string[] = [];
    for (const file of EXPORT_FILES) {
        if (!(await Bun.file(`${folder}/${file}`).exists())) missing.push(file);
    }
    summary[zip.name] = {
        folder,
        result:
            code !== 0
                ? `FAILED (unzip exit ${code})`
                : missing.length > 0
                  ? `unpacked, missing ${missing.join(', ')}`
                  : 'unpacked',
    };
}

console.table(summary);
