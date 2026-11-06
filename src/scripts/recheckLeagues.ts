/**
 * Rechecks stored matches against the leagues of match dumps (src/data/season_<N>/matches.json),
 * to undo season changes where matches of the old season were stored in the new one.
 * bun run src/scripts/recheckLeagues.ts [--data=src/data] [--leagues=<league>:<season id>,…]
 *     [--dry-run]
 *
 * A league belongs to the earliest season it was seen in: the dumps file matches under the
 * season they were read in, and a league only leaks forward, into the season after its own.
 * The season before the earliest dump is checked too, in our own collections.
 * With --dry-run nothing is written. Without it: the leagues are written to the `leagues`
 * register (the crawler reads it), then misfiled matches move to their season, keeping the
 * earliest time they were first seen. Restart the server afterwards: it keeps leagues in memory.
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
import { fetchSeasons } from '@/services/ninjakiwi';
import { toSeasonId } from '@/services/seasons';
import type { Match } from '@/types/match';
import { readJsonObjects } from '@/utils/readJsonObjects';

interface DumpRecord {
    season?: string; // NK HoM event id the record was read under, e.g. "mt8f8io3"
    body?: Match;
}

interface LeagueInfo {
    /** our season ids of the dumps it appears in */
    dumpSeasons: Set<number>;
    ids: string[];
    seasonId?: number;
    /** found in our collection of the season before its earliest dump */
    inEarlierSeason?: boolean;
}

// ---------- args ----------

const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
        const [key, value] = arg.replace(/^--/, '').split('=');
        return [key, value ?? 'true'];
    }),
);
const dataDir = (args.data ?? 'src/data').replace(/\/$/, '');
const dryRun = args['dry-run'] === 'true';
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

const files = [...new Bun.Glob('season_*/matches.json').scanSync(dataDir)]
    .map((path) => `${dataDir}/${path}`)
    .sort();
if (files.length === 0) {
    console.error(`No season_*/matches.json under ${dataDir}`);
    process.exit(1);
}

function chunks<T>(list: T[], size = 1000): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

// ---------- NK seasons: event id → our id ----------

const nkList = await fetchSeasons();
if (nkList.length === 0) {
    console.error("Couldn't fetch NK's season list, try again in a minute.");
    process.exit(1);
}
const seasonOfEvent = new Map<string, number>();
for (const season of nkList) {
    const seasonId = toSeasonId(season);
    if (seasonId !== null) seasonOfEvent.set(season.id, seasonId);
}

await connectDB();
await loadLeagues();

// ---------- read the dumps ----------

const matches = new Map<string, Match>();
const leagues = new Map<string, LeagueInfo>();
const skipped = { malformed: 0, notRanked: 0, noLeague: 0, unknownEvent: 0, duplicates: 0 };
const unknownEvents = new Set<string>();

for (const file of files) {
    for await (const raw of readJsonObjects(file)) {
        const record = raw as DumpRecord;
        const match = record.body;
        if (!match?.id || !match.playerLeft || !match.playerRight) {
            skipped.malformed++;
            continue;
        }
        if (match.gametype !== 'Ranked') {
            skipped.notRanked++;
            continue;
        }
        if (!match.league || match.league === NK_NO_LEAGUE) {
            skipped.noLeague++;
            continue;
        }
        const dumpSeason = seasonOfEvent.get(record.season ?? '');
        if (dumpSeason === undefined) {
            skipped.unknownEvent++;
            unknownEvents.add(record.season ?? '(none)');
            continue;
        }
        const info = leagues.get(match.league) ?? { dumpSeasons: new Set(), ids: [] };
        info.dumpSeasons.add(dumpSeason);
        leagues.set(match.league, info);
        if (matches.has(match.id)) {
            skipped.duplicates++;
            continue;
        }
        matches.set(match.id, match);
        info.ids.push(match.id);
    }
    console.log(`Read ${file}`);
}

// ---------- each league's season ----------

for (const [league, info] of leagues) {
    const earliest = Math.min(...info.dumpSeasons);
    let inEarlier = false;
    for (const ids of chunks(info.ids)) {
        if ((await findStoredIds(ids, earliest - 1)).size > 0) {
            inEarlier = true;
            break;
        }
    }
    info.inEarlierSeason = inEarlier;
    info.seasonId = overrides.get(league) ?? (inEarlier ? earliest - 1 : earliest);
}

// ---------- where each match is stored ----------

const seasonsToCheck = new Set<number>();
for (const info of leagues.values()) {
    for (const s of info.dumpSeasons) seasonsToCheck.add(s);
    seasonsToCheck.add(Math.min(...info.dumpSeasons) - 1);
    seasonsToCheck.add(info.seasonId!);
}
/** match id → season → first seen (minutes) */
const storedIn = new Map<string, Map<number, number>>();
for (const seasonId of seasonsToCheck) {
    for (const ids of chunks([...matches.keys()])) {
        for (const [id, t] of await findStoredDates(ids, seasonId)) {
            const where = storedIn.get(id) ?? new Map<number, number>();
            where.set(seasonId, t);
            storedIn.set(id, where);
        }
    }
}

interface Move {
    match: Match;
    from: number[];
    to: number;
    /** earliest first-seen time among its copies */
    t: number;
}
const moves: Move[] = [];
let rightPlace = 0;
let notStored = 0;
const moveCounts = new Map<string, number>();
for (const [league, info] of leagues) {
    const to = info.seasonId!;
    for (const id of info.ids) {
        const where = storedIn.get(id);
        if (!where) {
            notStored++;
            continue;
        }
        const from = [...where.keys()].filter((s) => s !== to);
        if (from.length === 0) {
            rightPlace++;
            continue;
        }
        moves.push({ match: matches.get(id)!, from, to, t: Math.min(...where.values()) });
        const key = `${league}: ${from.join('+')} → ${to}`;
        moveCounts.set(key, (moveCounts.get(key) ?? 0) + 1);
    }
}

// ---------- report ----------

console.log(dryRun ? '\nDRY RUN: nothing written' : '\nWriting');
console.log('\nLeagues');
console.table(
    Object.fromEntries(
        [...leagues]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([league, info]) => [
                league,
                {
                    'dump matches': info.ids.length,
                    'in dumps of': [...info.dumpSeasons].sort().join(', '),
                    'seen in season before': info.inEarlierSeason ? 'yes' : '',
                    season: info.seasonId,
                    'register now': seasonOfLeague(league) ?? '',
                    override: overrides.has(league) ? 'yes' : '',
                },
            ]),
    ),
);
console.log('\nMatches of the dumps');
console.table({
    'stored in their season': rightPlace,
    'stored in another season (to move)': moves.length,
    'not stored (importMatches can add them)': notStored,
});
if (moveCounts.size > 0) console.log('Moves:', Object.fromEntries(moveCounts));
console.log('\nSkipped');
console.table(skipped);
if (unknownEvents.size > 0) console.log('Events not in NK season list:', [...unknownEvents]);

// ---------- write ----------

try {
    if (!dryRun) {
        for (const [league, info] of leagues) {
            const before = await setLeagueSeason(league, info.seasonId!);
            if (before !== info.seasonId) {
                console.log(`League ${league}: ${before ?? 'new'} → ${info.seasonId}`);
            }
        }

        let moved = 0;
        let copies = 0;
        const byTarget = new Map<number, Move[]>();
        for (const move of moves) byTarget.set(move.to, [...(byTarget.get(move.to) ?? []), move]);
        for (const [to, list] of byTarget) {
            for (const batch of chunks(list)) {
                const firstSeen = new Map(batch.map((m) => [m.match.id, m.t]));
                await saveCrawledMatches(
                    batch.map((m) => m.match),
                    to,
                    (m) => firstSeen.get(m.id),
                    { renamePlayers: false },
                );
                // only take out of the wrong season what really is in the right one now
                const there = await findStoredIds([...firstSeen.keys()], to);
                const bySource = new Map<number, string[]>();
                for (const move of batch) {
                    if (!there.has(move.match.id)) continue;
                    moved++;
                    for (const from of move.from) {
                        bySource.set(from, [...(bySource.get(from) ?? []), move.match.id]);
                    }
                }
                for (const [from, ids] of bySource) copies += await deleteMatches(ids, from);
            }
        }
        const left = moves.length - moved;
        console.log(
            `\n${moved} match(es) moved, ${copies} misfiled copies removed` +
                (left > 0 ? `, ${left} not accepted by their season and left as they were` : ''),
        );
    }
} finally {
    await mongoose.disconnect();
}

process.exit(0);
