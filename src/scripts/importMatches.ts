/**
 * Import matches from an external dump into matches_s<season>.
 * bun run src/scripts/importMatches.ts --file=src/data/matches.json --season=46 [--dry-run] [--batch=1000]
 */
import mongoose from 'mongoose';
import connectDB from '@/services/database';
import { rememberMatchAssets } from '@/services/matchMeta';
import { saveCrawledMatches } from '@/services/matchStore';
import type { Match } from '@/types/match';
import { logger } from '@/utils/logger';

interface ImportedRecord {
    _id?: string;
    date?: number; // unix seconds
    season?: string; // NK season key, "mt8f8io3"
    body?: Match;
}

// ---------- args ----------

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value] = arg.replace(/^--/, '').split('=');
        return [key, value ?? 'true'];
    }),
);
const file = args.file;
const seasonId = Number(args.season);
const batchSize = Math.max(1, Number(args.batch ?? 1000));
const dryRun = args['dry-run'] === 'true';

if (!file || !Number.isInteger(seasonId) || seasonId < 1) {
    console.error(
        'Usage: --file=<path> --season=<our season id, e.g. 46> [--dry-run] [--batch=1000]',
    );
    process.exit(1);
}
if (!(await Bun.file(file).exists())) {
    console.error(`File not found: ${file}`);
    process.exit(1);
}

// ---------- streaming reader: yields each top-level {...} ----------

async function* readObjects(path: string): AsyncGenerator<unknown> {
    const decoder = new TextDecoder();
    let buf = '';
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for await (const chunk of Bun.file(path).stream()) {
        const from = buf.length;
        buf += decoder.decode(chunk, { stream: true });
        for (let i = from; i < buf.length; i++) {
            const ch = buf[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === '{') {
                if (depth++ === 0) start = i;
            } else if (ch === '}' && --depth === 0) {
                yield JSON.parse(buf.slice(start, i + 1));
                start = -1;
            }
        }
        // drop what is already parsed
        if (start === -1) buf = '';
        else {
            buf = buf.slice(start);
            start = 0;
        }
    }
}

// ---------- import ----------

const totals = {
    read: 0,
    malformed: 0,
    notRanked: 0,
    duplicates: 0,
    sent: 0,
    inserted: 0,
    invalid: 0,
};
const nkSeasons = new Map<string, number>();
let batch = new Map<string, { match: Match; t?: number }>();
const started = Date.now();

async function flush() {
    if (batch.size === 0) return;
    const items = [...batch.values()];
    batch = new Map();
    totals.sent += items.length;
    if (dryRun) return;

    const matches = items.map((i) => i.match);
    const dates = new Map(items.map((i) => [i.match.id, i.t]));
    await rememberMatchAssets(matches);
    const result = await saveCrawledMatches(matches, seasonId, (m) => dates.get(m.id));
    totals.inserted += result.inserted;
    totals.invalid += result.invalid;
    logger.info(
        `${totals.sent} sent, ${totals.inserted} new, ${totals.invalid} invalid (${Math.round((Date.now() - started) / 1000)} s)`,
    );
}

if (!dryRun) await connectDB();

try {
    for await (const raw of readObjects(file)) {
        totals.read++;
        const record = raw as ImportedRecord;
        const match = record.body;
        if (!match?.id || !match.playerLeft || !match.playerRight) {
            totals.malformed++;
            continue;
        }
        if (match.gametype !== 'Ranked') {
            totals.notRanked++;
            continue;
        }
        if (record.season) nkSeasons.set(record.season, (nkSeasons.get(record.season) ?? 0) + 1);

        const t =
            typeof record.date === 'number' && Number.isFinite(record.date)
                ? Math.floor(record.date / 60)
                : undefined;
        const existing = batch.get(match.id);
        if (existing) {
            totals.duplicates++;
            if (t !== undefined && (existing.t === undefined || t < existing.t)) existing.t = t;
            continue;
        }
        batch.set(match.id, { match, t });
        if (batch.size >= batchSize) await flush();
    }
    await flush();
} finally {
    if (!dryRun) await mongoose.disconnect();
}

console.log(dryRun ? '\nDRY RUN, nothing written' : '\nDone');
console.table({
    'records read': totals.read,
    malformed: totals.malformed,
    'not ranked (skipped)': totals.notRanked,
    'duplicates in file': totals.duplicates,
    'sent to db': totals.sent,
    'new matches': dryRun ? '-' : totals.inserted,
    'already stored': dryRun ? '-' : totals.sent - totals.inserted - totals.invalid,
    'invalid (codes/range)': dryRun ? '-' : totals.invalid,
});
console.log('NK season keys in file:', Object.fromEntries(nkSeasons));
if (nkSeasons.size > 1)
    console.warn('⚠ More than one NK season in this file: split it before importing.');
