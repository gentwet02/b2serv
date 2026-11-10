import { Hono } from 'hono';
import { CLANS_LIST_TTL_MS } from '@/config/cache';
import { ERROR_MESSAGES } from '@/config/errors';
import { clanMemberIds, loadClanMembers } from '@/services/clanMembers';
import { clanOverview } from '@/services/clanOverview';
import { getClan, listClans } from '@/services/clanStore';
import { loadCodeBook } from '@/services/codeBook';
import { nameOfUser } from '@/services/h2h';
import {
    getRankHistory,
    getSeasonRank,
    getSeasonScore,
    readLeaderboard,
} from '@/services/leaderboard';
import { getLiveSeason } from '@/services/seasons';
import type { ClanMember } from '@/types/clan';
import { createCache } from '@/utils/cache';
import { isOverloaded } from '@/utils/heavy';
import { logger } from '@/utils/logger';
import { aliasOf, tagOf } from '@/utils/players';
import { isNkGuildId } from '@/validators/nk';

/**
 * Clans, from the database (the profile sweep reads them): never asks NK.
 *
 * GET /clans       every clan with a player we know, the most known players first
 * GET /clans/:id   one clan and its known members (their rank in the live season, their best)
 * GET /clans/:id/overview   its members' games added up: this season (recorded matches) and
 *                  all time (NK's lifetime numbers), with the most active and best player
 *                  and the rival clans; season by season; against the top clans; and each
 *                  member's record
 *
 * A clan's games and stats: /stats and /compare with ?clan=<id>.
 */
export const clans = new Hono();

const listCache = createCache({ ttlMs: CLANS_LIST_TTL_MS, max: 1 });

clans.get('/', async (c) => {
    try {
        const list = await listCache('clans', listClans);
        c.header('Cache-Control', 'public, max-age=300');
        return c.json({ clans: list });
    } catch (error) {
        logger.error(`Clans list failed: ${error}`);
        const message = 'Could not list the clans.';
        return c.json({ message, error: message }, 500);
    }
});

clans.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!isNkGuildId(id)) {
        const message = ERROR_MESSAGES.INVALID_CLAN_ID;
        return c.json({ message, error: message }, 400);
    }
    try {
        await Promise.all([loadCodeBook(), loadClanMembers()]);
        const clan = await getClan(id);
        if (!clan) {
            const message = "We don't know this clan.";
            return c.json({ message, error: 'not_found' }, 404);
        }
        // ranks: the live leaderboard
        const live = getLiveSeason();
        if (live) await readLeaderboard(live);
        const members: ClanMember[] = clanMemberIds(id).map((userId) => {
            const { seasons } = getRankHistory(userId);
            return {
                userId,
                name: nameOfUser(userId),
                alias: aliasOf(userId) ?? null,
                tag: tagOf(userId) ?? null,
                rank: live ? getSeasonRank(live.seasonId, userId) : null,
                score: live ? getSeasonScore(live.seasonId, userId) : null,
                bestRank: seasons.length ? Math.min(...seasons.map((s) => s.rank)) : null,
                bestScore: seasons.length ? Math.max(...seasons.map((s) => s.score)) : null,
            };
        });
        members.sort(
            (x, y) =>
                (x.rank ?? Infinity) - (y.rank ?? Infinity) ||
                (x.name ?? '').localeCompare(y.name ?? ''),
        );
        c.header('Cache-Control', 'public, max-age=60');
        return c.json({
            clan,
            members,
            seasonId: live?.seasonId ?? null,
            seasonName: live?.name ?? null,
        });
    } catch (error) {
        logger.error(`Clan ${id} failed: ${error}`);
        const message = 'Could not load this clan.';
        return c.json({ message, error: message }, 500);
    }
});

clans.get('/:id/overview', async (c) => {
    const id = c.req.param('id');
    if (!isNkGuildId(id)) {
        const message = ERROR_MESSAGES.INVALID_CLAN_ID;
        return c.json({ message, error: message }, 400);
    }
    try {
        await Promise.all([loadCodeBook(), loadClanMembers()]);
        const data = await clanOverview(id);
        c.header('Cache-Control', 'public, max-age=60');
        return c.json(data);
    } catch (error) {
        if (isOverloaded(error)) {
            c.header('Retry-After', '10');
            return c.json({ message: ERROR_MESSAGES.BUSY, error: 'busy' }, 503);
        }
        logger.error(`Clan overview of ${id} failed: ${error}`);
        const message = "Could not compute this clan's stats.";
        return c.json({ message, error: message }, 500);
    }
});
