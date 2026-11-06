import mongoose from 'mongoose';
import { COLLECTIONS } from '@/config/db';
import { NK_NO_LEAGUE } from '@/config/nk';
import { findStoredIds } from '@/services/matchStore';
import { getLiveSeason, refreshSeasons } from '@/services/seasons';
import { logger } from '@/utils/logger';

/**
 * The season of each NK league (a match's `league`), kept in `leagues`.
 *
 * A league is a HoM period of a few days inside a season, and never crosses a season boundary.
 * NK doesn't say which season it is part of, and its id can't be dated (base-36 creation time,
 * but NK makes ids ahead of time), so we learn it: the crawler sees every league while it is
 * played, so a league we have never seen belongs to the live season, and the last league of a
 * season is already known when the next season starts. If we weren't running then (first
 * deploy, downtime), its matches already stored in the previous season give it away.
 */

interface LeagueDoc {
    /** NK league id */
    _id: string;
    /** season id */
    s: number;
    /** when we learned it */
    t: Date;
}

const known = new Map<string, number>();
let loading: Promise<void> | null = null;
let learning: Promise<void> | null = null;

function leagues() {
    return mongoose.connection.collection<LeagueDoc>(COLLECTIONS.LEAGUES);
}

export function loadLeagues(): Promise<void> {
    loading ??= (async () => {
        for (const doc of await leagues().find().toArray()) known.set(doc._id, doc.s);
        logger.debug(`Leagues: ${known.size} known`);
    })().catch((error) => {
        loading = null;
        throw error;
    });
    return loading;
}

/** null: a league not learned yet (learnLeagues), or not loaded yet (loadLeagues). */
export function seasonOfLeague(league: string): number | null {
    return known.get(league) ?? null;
}

async function learn(matchIds: Map<string, string[]>) {
    await loadLeagues();
    const unknown = [...matchIds].filter(
        ([league]) => league !== NK_NO_LEAGUE && !known.has(league),
    );
    if (unknown.length === 0) return;

    // a new league is often the first sign of a new season: don't file it under the old one
    await refreshSeasons();
    const live = getLiveSeason();
    if (!live) return;

    for (const [league, ids] of unknown) {
        const previous = live.seasonId - 1;
        const inPrevious = (await findStoredIds(ids, previous)).size > 0;
        const seasonId = inPrevious ? previous : live.seasonId;
        await leagues().updateOne(
            { _id: league },
            { $setOnInsert: { s: seasonId, t: new Date() } },
            { upsert: true },
        );
        known.set(league, seasonId);
        logger.info(
            `League ${league}: season ${seasonId}` +
                (inPrevious ? ' (its matches were already stored there)' : ' (live season)'),
        );
    }
}

/**
 * Files new leagues under a season, from some of their match ids (league → ids).
 * One learning at a time: a call made meanwhile is dropped, its leagues come back next flush.
 */
export function learnLeagues(matchIds: Map<string, string[]>): Promise<void> {
    learning ??= learn(matchIds).finally(() => {
        learning = null;
    });
    return learning;
}

/**
 * Files a league under a season, replacing what was learned (scripts/recheckLeagues.ts).
 * Returns the season it was filed under before, null when it was new.
 */
export async function setLeagueSeason(league: string, seasonId: number): Promise<number | null> {
    const before = await leagues().findOneAndUpdate(
        { _id: league },
        { $set: { s: seasonId }, $setOnInsert: { t: new Date() } },
        { upsert: true, returnDocument: 'before' },
    );
    known.set(league, seasonId);
    return before?.s ?? null;
}
