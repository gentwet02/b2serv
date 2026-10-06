import { env } from '@/config/environment';
import { fetchLeaderboard } from '@/services/ninjakiwi';
import { getLiveSeason, type SeasonInfo } from '@/services/seasons';
import type { LeaderboardPlayer, LeaderboardPlayerEncoded } from '@/types/leaderboard';
import { encodePlayer } from '@/utils/encode';
import { logger } from '@/utils/logger';
import { scheduleEvery } from '@/utils/scheduler';

interface LeaderboardEntry {
    players: LeaderboardPlayer[];
    encoded: LeaderboardPlayerEncoded[];
    updatedAt: Date;
}

const cache = new Map<number, LeaderboardEntry>();
const inFlight = new Map<number, Promise<void>>();

export function updateLeaderboard(season: SeasonInfo): Promise<void> {
    const id = season.seasonId;
    const running = inFlight.get(id);
    if (running) return running;

    const job = (async () => {
        logger.debug(`Updating leaderboard cache of season ${id}`);
        const players = await fetchLeaderboard(id);
        if (players.length === 0) {
            logger.error(`Season ${id}: empty leaderboard, keeping the previous cache`);
            return;
        }
        cache.set(id, {
            players,
            encoded: players.map((player) => encodePlayer(player)),
            updatedAt: new Date(),
        });
        logger.debug(`Season ${id}: ${players.length} players cached`);
    })()
        .catch((error) => logger.error(`Leaderboard update of season ${id} failed: ${error}`))
        .finally(() => inFlight.delete(id));

    inFlight.set(id, job);
    return job;
}

export const getCachedLeaderboard = (seasonId: number) => cache.get(seasonId) ?? null;

export async function getLeaderboardPlayers(season: SeasonInfo, maxAgeMs = env.NK_FETCH_INTERVAL) {
    const entry = cache.get(season.seasonId);
    if (!entry || Date.now() - entry.updatedAt.getTime() > maxAgeMs) {
        await updateLeaderboard(season);
    }
    return cache.get(season.seasonId)?.players ?? [];
}

export async function startLeaderboardScheduler() {
    const live = getLiveSeason();
    if (live) {
        await updateLeaderboard(live);
    } else {
        logger.error('Leaderboard: no live season at startup, waiting for the next run');
    }

    scheduleEvery(
        'leaderboard-live',
        async () => {
            const season = getLiveSeason();
            if (season) await updateLeaderboard(season);
        },
        env.NK_FETCH_INTERVAL,
    );
}
