/**
 * Import matches from an external dump into matches_s<season>.
 * bun run src/scripts/importMatches.ts --file=<path> [--season=46] [--dry-run] [--batch=1000]
 */
import mongoose from 'mongoose';
import connectDB from '@/services/database';
import { CODE_BITS, codeOf, namesOf, playerCodeOf, type CodeKind } from '@/services/codeBook';
import { rememberMatchAssets } from '@/services/matchMeta';
import { countMatches, findStoredDates, saveCrawledMatches } from '@/services/matchStore';
import { fetchSeasons } from '@/services/ninjakiwi';
import { toSeasonId } from '@/services/seasons';
import type { Match } from '@/types/match';
import { extractUserId } from '@/utils/helpers';

interface ImportedRecord {
    _id?: string;
    date?: number; // unix seconds
    season?: string; // NK season key, e.g. "mt8f8io3"
    body?: Match;
}

interface SeasonRef {
    seasonId: number;
    name: string;
    key: string;
    start: number; // ms
    end: number; // ms
    live: boolean;
}

interface SeasonStats {
    ref: SeasonRef | null;
    records: number;
    outsideWindow: number;
    inDbBefore: number;
    notInDb: number;
    alreadyStored: number;
    earlierDate: number;
    inserted: number;
    invalid: number;
}

// ---------- args ----------

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value] = arg.replace(/^--/, '').split('=');
        return [key, value ?? 'true'];
    }),
);
const file = args.file;
const expected = args.season !== undefined ? Number(args.season) : undefined;
const batchSize = Math.max(1, Number(args.batch ?? 1000));
const dryRun = args['dry-run'] === 'true';

if (!file || (expected !== undefined && !(Number.isInteger(expected) && expected > 0))) {
    console.error('Usage: --file=<path> [--season=<our season id>] [--dry-run] [--batch=1000]');
    process.exit(1);
}
if (!(await Bun.file(file).exists())) {
    console.error(`File not found: ${file}`);
    process.exit(1);
}

// ---------- streaming reader: yields each match object ----------

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
        if (start === -1) buf = '';
        else {
            buf = buf.slice(start);
            start = 0;
        }
    }
}

// ---------- NK seasons: key → our id ----------

const toMs = (v: number) => (v < 1e12 ? v * 1000 : v);
const WINDOW_MARGIN_MS = 60 * 60_000;

const nkList = await fetchSeasons();
if (nkList.length === 0) {
    console.error("Couldn't fetch NK's season list, try again in a minute.");
    process.exit(1);
}
const byKey = new Map<string, SeasonRef>();
const byId = new Map<number, SeasonRef>();
for (const s of nkList) {
    const seasonId = toSeasonId(s);
    if (seasonId === null) continue;
    const ref = {
        seasonId,
        name: s.name,
        key: s.id,
        start: toMs(s.start),
        end: toMs(s.end),
        live: s.live,
    };
    byKey.set(s.id, ref);
    byId.set(seasonId, ref);
}

// ---------- state ----------

await connectDB(); // reads the code book; writes happen only without --dry-run

const skipped = { malformed: 0, notRanked: 0, duplicates: 0, unknownKey: 0, otherSeason: 0 };
const unknownKeys = new Map<string, number>();
const otherSeasons = new Map<string, number>();
const stats = new Map<number, SeasonStats>();
const batches = new Map<number, Map<string, { match: Match; t?: number }>>();
const seenIds = new Map<number, Set<string>>();
let outOfRange = 0;

const newCodes: Record<CodeKind, Set<string>> = {
    hero: new Set(),
    tower: new Set(),
    map: new Set(),
    result: new Set(),
};
const newPlayers = new Set<string>();

function previewCodes(match: Match) {
    const add = (kind: CodeKind, name: string) => {
        if (name && codeOf(kind, name) === undefined) newCodes[kind].add(name);
    };
    add('map', match.map);
    add('result', match.playerLeft.result);
    for (const p of [match.playerLeft, match.playerRight]) {
        add('hero', p.hero);
        for (const t of [p.towerone, p.towertwo, p.towerthree]) add('tower', t);
        const user = extractUserId(p.profileURL);
        if (user && playerCodeOf(user) === undefined) newPlayers.add(user);
    }
    const round = Math.round(match.endRound);
    const duration = Math.round(match.duration);
    if (!(round >= 0 && round <= 127) || !(duration >= 0 && duration <= 16383)) outOfRange++;
}

async function statsFor(seasonId: number): Promise<SeasonStats> {
    let entry = stats.get(seasonId);
    if (!entry) {
        entry = {
            ref: byId.get(seasonId) ?? null,
            records: 0,
            outsideWindow: 0,
            inDbBefore: await countMatches(seasonId),
            notInDb: 0,
            alreadyStored: 0,
            earlierDate: 0,
            inserted: 0,
            invalid: 0,
        };
        stats.set(seasonId, entry);
    }
    return entry;
}

async function flush(seasonId: number) {
    const batch = batches.get(seasonId);
    if (!batch || batch.size === 0) return;
    batches.delete(seasonId);
    const items = [...batch.values()];
    const entry = await statsFor(seasonId);

    const stored = await findStoredDates(
        items.map((i) => i.match.id),
        seasonId,
    );
    for (const { match, t } of items) {
        const storedT = stored.get(match.id);
        if (storedT === undefined) entry.notInDb++;
        else {
            entry.alreadyStored++;
            if (t !== undefined && t < storedT) entry.earlierDate++;
        }
    }
    if (dryRun) return;

    const matches = items.map((i) => i.match);
    const dates = new Map(items.map((i) => [i.match.id, i.t]));
    await rememberMatchAssets(matches);
    const result = await saveCrawledMatches(matches, seasonId, (m) => dates.get(m.id));
    entry.inserted += result.inserted;
    entry.invalid += result.invalid;
    console.log(`season ${seasonId}: ${entry.inserted} inserted so far`);
}

// ---------- read ----------

try {
    for await (const raw of readObjects(file)) {
        const record = raw as ImportedRecord;
        const match = record.body;
        if (!match?.id || !match.playerLeft || !match.playerRight) {
            skipped.malformed++;
            continue;
        }
        if (match.gametype !== 'Ranked') {
            skipped.notRanked++;
            continue;
        }

        const key = record.season ?? '';
        const ref = byKey.get(key);
        let seasonId: number;
        if (ref) {
            if (expected !== undefined && ref.seasonId !== expected) {
                skipped.otherSeason++;
                otherSeasons.set(
                    `${key} → ${ref.seasonId}`,
                    (otherSeasons.get(`${key} → ${ref.seasonId}`) ?? 0) + 1,
                );
                continue;
            }
            seasonId = ref.seasonId;
        } else if (expected !== undefined) {
            seasonId = expected; // NK doesn't list this key: trust --season
            unknownKeys.set(key, (unknownKeys.get(key) ?? 0) + 1);
        } else {
            skipped.unknownKey++;
            unknownKeys.set(key, (unknownKeys.get(key) ?? 0) + 1);
            continue;
        }

        let ids = seenIds.get(seasonId);
        if (!ids) seenIds.set(seasonId, (ids = new Set()));
        if (ids.has(match.id)) {
            skipped.duplicates++;
            continue;
        }
        ids.add(match.id);

        const entry = await statsFor(seasonId);
        entry.records++;
        const dateMs =
            typeof record.date === 'number' && Number.isFinite(record.date)
                ? record.date * 1000
                : undefined;
        const window = entry.ref;
        if (
            dateMs !== undefined &&
            window &&
            (dateMs < window.start - WINDOW_MARGIN_MS || dateMs > window.end + WINDOW_MARGIN_MS)
        ) {
            entry.outsideWindow++;
        }

        previewCodes(match);

        let batch = batches.get(seasonId);
        if (!batch) batches.set(seasonId, (batch = new Map()));
        batch.set(match.id, {
            match,
            t: dateMs !== undefined ? Math.floor(dateMs / 60_000) : undefined,
        });
        if (batch.size >= batchSize) await flush(seasonId);
    }
    for (const seasonId of [...batches.keys()]) await flush(seasonId);
} finally {
    await mongoose.disconnect();
}

// ---------- report ----------

console.log(dryRun ? '\nDRY RUN: DB and NK read, nothing written' : '\nDone');

console.log('\nPer season');
console.table(
    Object.fromEntries(
        [...stats].map(([id, s]) => [
            `${id}${s.ref ? ` (${s.ref.name}, ${s.ref.key}${s.ref.live ? ', live' : ''})` : ' (not in NK list)'}`,
            {
                'in file': s.records,
                'date outside season': s.outsideWindow,
                'in db before': s.inDbBefore,
                'already stored': s.alreadyStored,
                'not in db': s.notInDb,
                'date moves earlier': s.earlierDate,
                ...(dryRun ? {} : { inserted: s.inserted, invalid: s.invalid }),
            },
        ]),
    ),
);

console.log('\nSkipped');
console.table({
    malformed: skipped.malformed,
    'not ranked': skipped.notRanked,
    'duplicates in file': skipped.duplicates,
    'unknown NK season key': skipped.unknownKey,
    'other season than --season': skipped.otherSeason,
    'round/duration out of range': outOfRange,
});
if (unknownKeys.size > 0)
    console.log('NK keys not in NK season list:', Object.fromEntries(unknownKeys));
if (otherSeasons.size > 0)
    console.log('Records of other seasons:', Object.fromEntries(otherSeasons));

console.log('\nCode book');
console.table(
    Object.fromEntries(
        (Object.keys(newCodes) as CodeKind[]).map((kind) => {
            const total = namesOf(kind).length + newCodes[kind].size;
            return [
                kind,
                {
                    new: newCodes[kind].size,
                    'total after': total,
                    capacity: 2 ** CODE_BITS[kind],
                    names: [...newCodes[kind]].slice(0, 8).join(', '),
                },
            ];
        }),
    ),
);
console.log(`New players: ${newPlayers.size}`);
for (const kind of Object.keys(newCodes) as CodeKind[]) {
    if (namesOf(kind).length + newCodes[kind].size > 2 ** CODE_BITS[kind]) {
        console.warn(
            `⚠ ${kind} codes would exceed ${CODE_BITS[kind]} bits: those matches would be invalid`,
        );
    }
}

process.exit(0);
