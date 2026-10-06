import { Hono } from 'hono';
import { env } from '@/config/environment';
import { matchesState, refreshMatchesHistory } from '@/services/matchesHistory';
import { scheduleEvery } from '@/utils/scheduler';

export const matchesHistory = new Hono();

matchesHistory.get('/', (c) => {
    const cache = matchesState.cache;
    return c.json({
        matches: cache,
        error: cache ? null : 'No data available yet. Data is being fetched in the background.',
        message: cache ? null : 'Please try again in a few minutes.',
    });
});

matchesHistory.get('/status', (c) => {
    const lastUpdated = matchesState.cache?.lastUpdated ?? null;
    return c.json({
        message: 'running',
        hasCache: !!matchesState.cache,
        isFetching: matchesState.isFetching,
        totalMatches: matchesState.cache?.totalMatches ?? 0,
        seasonId: matchesState.cache?.seasonID ?? null,
        lastUpdated: lastUpdated?.toISOString() ?? null,
        lastRunStartedAt: matchesState.lastRunStartedAt?.toISOString() ?? null,
        lastRunEndedAt: matchesState.lastRunEndedAt?.toISOString() ?? null,
        lastError: matchesState.lastError,
        lastSave: matchesState.lastSave,
        nextUpdateIn: lastUpdated
            ? Math.max(0, env.NK_FETCH_INTERVAL - (Date.now() - lastUpdated.getTime()))
            : 'unknown',
        timestamp: new Date().toISOString(),
    });
});

matchesHistory.get('/force-update', (c) => {
    if (matchesState.isFetching) {
        return c.json({ message: 'Update already in progress' });
    }
    // not awaited: a run takes minutes, the answer comes right away
    void refreshMatchesHistory();
    return c.json(
        { message: 'Force update triggered. Check /matches-history/status for progress.' },
        202,
    );
});

export async function startMatchesScheduler() {
    await refreshMatchesHistory();
    scheduleEvery('matches-history', refreshMatchesHistory, env.NK_FETCH_INTERVAL);
}
