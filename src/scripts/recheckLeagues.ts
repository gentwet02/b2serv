/**
 * Rechecks stored matches against the leagues of match dumps, to undo season changes where
 * matches of the old season were stored in the new one.
 * bun run src/scripts/recheckLeagues.ts [--data=src/data] [--from=46] [--to=48]
 *     [--leagues=<league>:<season id>,…] [--dry-run]
 * --from / --to: season numbers as shown, like importAll. NK sends leagues since season 46
 * (Aug 28 2026, ~13:30 UTC): older dumps have none, reading them only costs time.
 *
 * Dumps are <data>/season_<N>/matches.json, N the season number as shown (our id + 1): a dump
 * holds the matches read while that season was live. NK's season list isn't used, it drops old
 * seasons.
 *
 * A league belongs to the dump holding most of its matches: around a season change, a few
 * matches land in the dump next door (old ones read after the switch, new ones read before it).
 * A small league seen in one dump only is flagged: it can be the leak of a season whose dump has
 * no leagues (NK only sends them since season 46), set it with --leagues. Then each dump match
 * is looked for in its league's season, the seasons around it and its dump's season, and moved
 * where it belongs, keeping the earliest time it was first seen. The dumps are read twice, in
 * batches, so any number of seasons fits in memory.
 * With --dry-run nothing is written. Without it, the leagues also go to the `leagues` register
 * (the crawler reads it). Restart the server afterwards: it keeps leagues in memory.
 */
import mongoose from 'mongoose';
import { NK_NO_LEAGUE } from '@/config/nk';
import connectDB from '@/services/database';
import { loadLeagues, seasonOfLeague, setLeagueSeason } from '@/services/leagueStore';
import {
    deleteMatches,
    findStoredDates,
    findStoredIds,
    saveCrawledMatches,
} from '@/services/matchStore';
import type { Match } from '@/types/match';
import { readJsonObjects } from '@/utils/readJsonObjects';
import { isRanked } from '@/validators/match';

interface DumpRecord {
    season?: string; // NK HoM event id the record was read under, e.g. "mt8f8io3"
    body?: Match;
}

interface Dump {
    file: string;
    /** our season id */
    seasonId: number;
}

interface LeagueInfo {
    /** dump season id → matches */
    dumps: Map<number, number>;
    /** a few match ids of each dump, to look for in our collections */
    samples: Map<number, string[]>;
    seasonId?: number;
    /** sample matches of its main dump found in our collections of the seasons around it */
    storedBefore?: number;
    storedAfter?: number;
}

const BATCH_SIZE = 1000;
const SAMPLE_SIZE = 200;
/** a league seen in one dump only with fewer matches than this may be a leak: flagged */
const SMALL_LEAGUE = 200;
const DUMP_FOLDER = /^season_(\d+)\/matches\.json$/;

// ---------- args ----------

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value] = arg.replace(/^--/, '').split('=');
        return [key, value ?? 'true'];
    }),
);
const dataDir = (args.data ?? 'src/data').replace(/\/$/, '');
const dryRun = args['dry-run'] === 'true';
const from = Number(args.from ?? 0);
const to = Number(args.to ?? Infinity);
const overrides = new Map<string, number>();
for (const pair of (args.leagues ?? '').split(',').filter(Boolean)) {
    const [league, season] = pair.split(':');
    const seasonId = Number(season);
    if (!league || !Number.isInteger(seasonId) || seasonId < 0) {
        console.error(`Bad --leagues entry "${pair}": expected <league>:<season id>`);
        process.exit(1);
    }
    overrides.set(league, seasonId);
}

const dumps: Dump[] = [];
for (const path of new Bun.Glob('season_*/matches.json').scanSync(dataDir)) {
    const shown = Number(path.match(DUMP_FOLDER)?.[1]);
    if (!Number.isInteger(shown) || shown < 1) {
        console.warn(`Skipping ${path}: no season number in the folder name`);
        continue;
    }
    if (shown < from || shown > to) continue;
    dumps.push({ file: `${dataDir}/${path}`, seasonId: shown - 1 });
}
dumps.sort((a, b) => a.seasonId - b.seasonId);
if (dumps.length === 0) {
    console.error(`No season_<N>/matches.json under ${dataDir} for that range`);
    process.exit(1);
}

function chunks<T>(list: T[], size = BATCH_SIZE): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

/** The ranked matches of a dump that have a league, null for any other record. */
function leagueMatch(raw: unknown): Match | null {
    const match = (raw as DumpRecord).body;
    if (!match?.id || !match.playerLeft || !match.playerRight) return null;
    if (isRanked(match) || !match.league || match.league === NK_NO_LEAGUE) return null;
    return match;
}

await connectDB();
await loadLeagues();

// ---------- pass 1: which dumps each league appears in ----------

const leagues = new Map<string, LeagueInfo>();
const skipped = { malformed: 0, notRanked: 0, noLeague: 0 };
/** dump season id → NK event ids found in it (one expected) */
const eventsOf = new Map<number, Map<string, number>>();

for (const dump of dumps) {
    const events = new Map<string, number>();
    for await (const raw of readJsonObjects(dump.file)) {
        const record = raw as DumpRecord;
        const event = record.season ?? '(none)';
        events.set(event, (events.get(event) ?? 0) + 1);
        const match = leagueMatch(raw);
        if (!match) {
            if (!record.body?.id || !record.body.playerLeft || !record.body.playerRight) {
                skipped.malformed++;
            } else if (isRanked(record.body)) skipped.notRanked++;
            else skipped.noLeague++;
            continue;
        }
        const info = leagues.get(match.league!) ?? { dumps: new Map(), samples: new Map() };
        info.dumps.set(dump.seasonId, (info.dumps.get(dump.seasonId) ?? 0) + 1);
        const sample = info.samples.get(dump.seasonId) ?? [];
        if (sample.length < SAMPLE_SIZE) sample.push(match.id);
        info.samples.set(dump.seasonId, sample);
        leagues.set(match.league!, info);
    }
    eventsOf.set(dump.seasonId, events);
    console.log(`Read ${dump.file}`);
}

// ---------- each league's season ----------

function isSmall(info: LeagueInfo) {
    const total = [...info.dumps.values()].reduce((a, b) => a + b, 0);
    return info.dumps.size === 1 && total < SMALL_LEAGUE;
}

for (const [league, info] of leagues) {
    // most matches, the earlier season on a tie
    const [main] = [...info.dumps].sort(([a, n], [b, m]) => m - n || a - b)[0]!;
    const sample = info.samples.get(main) ?? [];
    info.storedBefore = (await findStoredIds(sample, main - 1)).size;
    info.storedAfter = (await findStoredIds(sample, main + 1)).size;
    info.seasonId = overrides.get(league) ?? main;
}

console.log(dryRun ? '\nDRY RUN: nothing written' : '\nWriting');
console.log('\nDumps');
console.table(
    Object.fromEntries(
        dumps.map((dump) => [
            dump.file,
            {
                season: dump.seasonId,
                'NK events': [...(eventsOf.get(dump.seasonId) ?? [])]
                    .map(([event, n]) => `${event} (${n})`)
                    .join(', '),
            },
        ]),
    ),
);
console.log('\nLeagues');
console.table(
    Object.fromEntries(
        [...leagues]
            .sort(([, a], [, b]) => a.seasonId! - b.seasonId!)
            .map(([league, info]) => [
                league,
                {
                    'dump matches': [...info.dumps]
                        .sort(([a], [b]) => a - b)
                        .map(([season, n]) => `${season}: ${n}`)
                        .join(', '),
                    'sample stored in season -1 / +1': `${info.storedBefore} / ${info.storedAfter}`,
                    season: info.seasonId,
                    'register now': seasonOfLeague(league) ?? '',
                    override: overrides.has(league) ? 'yes' : '',
                    check: isSmall(info) && !overrides.has(league) ? '⚠ small, one dump' : '',
                },
            ]),
    ),
);
for (const [season, events] of eventsOf) {
    if (events.size > 1) console.warn(`⚠ dump of season ${season} holds several NK events`);
}
const flagged = [...leagues].filter(([league, info]) => isSmall(info) && !overrides.has(league));
if (flagged.length > 0) {
    console.warn(
        `⚠ ${flagged.map(([league]) => league).join(', ')}: few matches in one dump only, maybe ` +
            'a leak from a season whose dump has no leagues. Check, then set with --leagues.',
    );
}

if (!dryRun) {
    for (const [league, info] of leagues) {
        const before = await setLeagueSeason(league, info.seasonId!);
        if (before !== info.seasonId) {
            console.log(`League ${league}: ${before ?? 'new'} → ${info.seasonId}`);
        }
    }
}

// ---------- pass 2: where each match is stored, moved where it belongs ----------

const counts = { rightPlace: 0, toMove: 0, moved: 0, copiesRemoved: 0, notStored: 0 };
const moveCounts = new Map<string, number>();

interface Move {
    match: Match;
    from: number[];
    to: number;
    /** earliest first-seen time among its copies */
    t: number;
}

async function writeMoves(moves: Move[]) {
    const byTarget = new Map<number, Move[]>();
    for (const move of moves) byTarget.set(move.to, [...(byTarget.get(move.to) ?? []), move]);
    for (const [to, list] of byTarget) {
        const firstSeen = new Map(list.map((m) => [m.match.id, m.t]));
        await saveCrawledMatches(
            list.map((m) => m.match),
            to,
            (m) => firstSeen.get(m.id),
            { renamePlayers: false },
        );
        // only take out of the wrong season what really is in the right one now
        const there = await findStoredIds([...firstSeen.keys()], to);
        const bySource = new Map<number, string[]>();
        for (const move of list) {
            if (!there.has(move.match.id)) continue;
            counts.moved++;
            for (const from of move.from) {
                bySource.set(from, [...(bySource.get(from) ?? []), move.match.id]);
            }
        }
        for (const [from, ids] of bySource) {
            counts.copiesRemoved += await deleteMatches(ids, from);
        }
    }
}

async function checkBatch(batch: Match[], dumpSeason: number) {
    const seasons = new Set<number>([dumpSeason]);
    for (const match of batch) {
        const to = leagues.get(match.league!)!.seasonId!;
        seasons.add(to - 1);
        seasons.add(to);
        seasons.add(to + 1);
    }
    /** match id → season → first seen (minutes) */
    const storedIn = new Map<string, Map<number, number>>();
    const ids = batch.map((m) => m.id);
    for (const seasonId of seasons) {
        for (const [id, t] of await findStoredDates(ids, seasonId)) {
            const where = storedIn.get(id) ?? new Map<number, number>();
            where.set(seasonId, t);
            storedIn.set(id, where);
        }
    }

    const moves: Move[] = [];
    for (const match of batch) {
        const where = storedIn.get(match.id);
        if (!where) {
            counts.notStored++;
            continue;
        }
        const to = leagues.get(match.league!)!.seasonId!;
        const from = [...where.keys()].filter((s) => s !== to);
        if (from.length === 0) {
            counts.rightPlace++;
            continue;
        }
        counts.toMove++;
        moves.push({ match, from, to, t: Math.min(...where.values()) });
        const key = `${match.league}: ${from.join('+')} → ${to}`;
        moveCounts.set(key, (moveCounts.get(key) ?? 0) + 1);
    }
    if (!dryRun && moves.length > 0) await writeMoves(moves);
}

try {
    for (const dump of dumps) {
        let batch: Match[] = [];
        for await (const raw of readJsonObjects(dump.file)) {
            const match = leagueMatch(raw);
            if (!match) continue;
            batch.push(match);
            if (batch.length >= BATCH_SIZE) {
                await checkBatch(batch, dump.seasonId);
                batch = [];
            }
        }
        if (batch.length > 0) await checkBatch(batch, dump.seasonId);
        console.log(`Checked ${dump.file}`);
    }
} finally {
    await mongoose.disconnect();
}

// ---------- report ----------

console.log('\nMatches of the dumps');
console.table({
    'stored in their season': counts.rightPlace,
    'stored in another season (to move)': counts.toMove,
    ...(dryRun
        ? {}
        : {
              moved: counts.moved,
              'misfiled copies removed': counts.copiesRemoved,
              'not accepted by their season (left as they were)': counts.toMove - counts.moved,
          }),
    'not stored (importMatches can add them)': counts.notStored,
});
if (moveCounts.size > 0) {
    console.log(
        'Moves:',
        Object.fromEntries([...moveCounts].sort(([a], [b]) => a.localeCompare(b))),
    );
}
console.log('\nSkipped');
console.table(skipped);

process.exit(0);
