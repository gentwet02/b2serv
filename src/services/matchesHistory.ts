import { processPlayersMatches } from '@/services/ninjakiwi';
import { saveMatches } from '@/services/database';
import { getLeaderboardPlayers } from '@/services/leaderboard';
import { getLiveSeason } from '@/services/seasons';
import type { CachedMatches, MatchDocument } from '@/types/match';
import { encodeMatch } from '@/utils/encode';
import { logger } from '@/utils/logger';

export const matchesState = {
    cache: null as CachedMatches | null,
    isFetching: false,
    lastRunStartedAt: null as Date | null,
    lastRunEndedAt: null as Date | null,
    lastError: null as string | null,
    lastSave: null as { inserted: number; invalid: number } | null,
};

export async function refreshMatchesHistory(): Promise<void> {
    if (matchesState.isFetching) {
        logger.debug('Matches history already being fetched, skipping');
        return;
    }

    const season = getLiveSeason();
    if (!season) {
        matchesState.lastError = 'Live season not available';
        logger.error('Matches history: no live season available');
        return;
    }

    const seasonId = season.seasonId;
    matchesState.isFetching = true;
    matchesState.lastError = null;
    matchesState.lastRunStartedAt = new Date();
    logger.debug(`Matches history: starting fetch for season ${seasonId}...`);

    try {
        const players = await getLeaderboardPlayers(season);
        if (players.length === 0) {
            throw new Error(`Empty leaderboard for season ${seasonId}`);
        }

        const allMatches = await processPlayersMatches(players);
        const ranked = allMatches.filter((match) => match.gametype === 'Ranked');

        matchesState.cache = {
            totalMatches: ranked.length,
            matches: ranked,
            seasonID: seasonId,
            lastUpdated: new Date(),
        };
        logger.debug(
            `Matches history: ${ranked.length} ranked out of ${allMatches.length} unique matches`,
        );

        const now = Date.now();
        const docs: MatchDocument[] = ranked.map((match) => ({ ...encodeMatch(match), t: now }));
        matchesState.lastSave = await saveMatches(docs, seasonId);
        logger.debug(
            `Season ${seasonId}: ${matchesState.lastSave.inserted} new matches saved, ${matchesState.lastSave.invalid} rejected`,
        );
    } catch (error) {
        matchesState.lastError = String(error);
        logger.error(`Matches history fetch failed: ${error}`);
    } finally {
        matchesState.isFetching = false;
        matchesState.lastRunEndedAt = new Date();
    }
}
