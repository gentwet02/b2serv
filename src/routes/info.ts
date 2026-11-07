import { Hono } from 'hono';
import { listMatchSeasons } from '@/services/matchStore';
import { countStoredProfiles } from '@/services/profileStore';
import { nextSweepInMs, profileSchedule, sweepState } from '@/services/profileSweep';
import { getLiveSeason, getSeasons, getSeasonsLastFetch } from '@/services/seasons';
import { getAssetReport } from '@/utils/assets';

export const info = new Hono();

info.get('/', async (c) => {
    const season = getLiveSeason();

    if (!season) {
        return c.json({ message: 'waiting for api response...', error: '425' });
    }

    return c.json({
        message: 'running',
        error: '200',
        liveSeason: season.seasonId,
        liveSeasonName: season.name,
        totalScores: season.totalScores,
        seasons: getSeasons().map((s) => ({ id: s.seasonId, name: s.name, live: s.live })),
        lastFetch: getSeasonsLastFetch()?.toISOString() ?? null,
        // the oldest season with recorded matches: "all seasons" starts there
        firstRecordedSeason: (await listMatchSeasons().catch(() => []))[0] ?? null,
    });
});

info.get('/assets', (c) => c.json(getAssetReport()));

/** GET /info/profiles: the profile sweep and how many profiles are stored. */
info.get('/profiles', async (c) =>
    c.json({
        ...sweepState,
        lastRunStartedAt: sweepState.lastRunStartedAt?.toISOString() ?? null,
        lastRunEndedAt: sweepState.lastRunEndedAt?.toISOString() ?? null,
        nextRunIn: nextSweepInMs() ?? 'running',
        schedule: profileSchedule.stats(Date.now()),
        stored: await countStoredProfiles().catch(() => null),
        lastRunStored: sweepState.stored,
    }),
);
