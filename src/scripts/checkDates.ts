/** bun run src/scripts/checkDates.ts ./src/data/<file>.json */
import { fetchSeasons } from '@/services/ninjakiwi';

const toMs = (v: number) => (v < 1e12 ? v * 1000 : v);
const seasons = new Map((await fetchSeasons()).map((s) => [s.id, s]));
const records = (await Bun.file(process.argv[2]!).json()) as {
    date: number;
    season: string;
    body: { id: string };
}[];

for (const r of records) {
    const s = seasons.get(r.season);
    if (!s) continue;
    const date = r.date * 1000;
    const [start, end] = [toMs(s.start), toMs(s.end)];
    const hours = date < start ? (date - start) / 3.6e6 : date > end ? (date - end) / 3.6e6 : 0;
    if (Math.abs(hours) > 1)
        console.log(
            r.body.id,
            new Date(date).toISOString(),
            `${hours > 0 ? '+' : ''}${hours.toFixed(1)} h`,
            hours > 0 ? 'after end' : 'before start',
        );
}
console.log(
    'season window:',
    ...[...seasons.values()]
        .filter((s) => records.some((r) => r.season === s.id))
        .map(
            (s) =>
                `${s.name}: ${new Date(toMs(s.start)).toISOString()} → ${new Date(toMs(s.end)).toISOString()}`,
        ),
);
process.exit(0);
