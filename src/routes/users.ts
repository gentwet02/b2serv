import { Hono, type Context } from 'hono';
import {
    ensureLeaderboard,
    getRankHistory,
    getSeasonRank,
    getTopPlayers,
} from '@/services/leaderboard';
import {
    getSeasonStats,
    headToHead,
    listMatchSeasons,
    OpponentInput,
    opponentsMet,
    versus,
    VersusSeason,
} from '@/services/matchStore';
import { getPlayerData } from '@/services/playerData';
import { getLiveSeason, getSeasonById } from '@/services/seasons';
import { logger } from '@/utils/logger';
import { fixProfileAssets } from '@/utils/assets';
import { extractUserId } from '@/utils/helpers';

/**
 * Player data for the client. The browser never calls Ninja Kiwi itself.
 *
 * GET /users/:id           NK profile (memory → MongoDB → NK, see services/playerData.ts)
 * GET /users/:id/matches   NK recent matches (fallback when we stored none)
 * GET /users/:id/season    season record from the stored matches
 * GET /users/:id/ranks     rank in every stored season, best end-of-season finish
 * GET /users/:id/compare   the player against the season's top 10, or ?with=id1,id2…
 */
export const users = new Hono();

const USER_ID = /^[a-z0-9]{8,64}$/i;

const invalid = (c: Context) => {
    const message = 'Invalid user id';
    return c.json({ message, error: message }, 400);
};

function proxy(kind: 'profile' | 'matches') {
    return async (c: Context) => {
        const id = c.req.param('id') ?? '';
        if (!USER_ID.test(id)) return invalid(c);

        const entry = await getPlayerData(kind, id);
        if (!entry) {
            const message = "Ninja Kiwi's API didn't answer. Try again in a moment.";
            return c.json({ message, error: 'upstream_unavailable' }, 502);
        }
        if (!entry.data.success) {
            const message = entry.data.error || 'Player not found';
            return c.json({ message, error: message }, 404);
        }

        const data = kind === 'profile' ? fixProfileAssets(entry.data) : entry.data;
        return c.json({ ...data, fetchedAt: new Date(entry.fetchedAt).toISOString() });
    };
}

users.get('/:id/season', async (c) => {
    const id = c.req.param('id');
    if (!USER_ID.test(id)) return invalid(c);
    const seasonParam = c.req.query('season');
    const season = seasonParam ? getSeasonById(Number(seasonParam)) : getLiveSeason();
    if (!season) {
        const message = 'Unknown season';
        return c.json({ message, error: message }, 404);
    }
    try {
        return c.json({ ...(await getSeasonStats(id, season.seasonId)), seasonName: season.name });
    } catch (error) {
        logger.error(`Season stats of ${id} failed: ${error}`);
        const message = 'Could not compute the season record.';
        return c.json({ message, error: message }, 500);
    }
});

const MAX_OPPONENTS = 10;

/**
 * GET /users/:id/compare: the player's games against each opponent (head to head)
 *   ?season=46 | all      default: live season; "all" = every stored season
 *   &with=id1,id2         up to 10 opponents, in this order; default: the top 10 (without the player)
 */
users.get('/:id/compare', async (c) => {
    const id = c.req.param('id');
    if (!USER_ID.test(id)) return invalid(c);
    const seasonParam = c.req.query('season');
    const all = seasonParam === 'all';
    const live = getLiveSeason();
    const season = all ? null : seasonParam ? getSeasonById(Number(seasonParam)) : live;
    if (!all && !season) {
        const message = seasonParam ? 'Unknown season' : 'Live season not available yet';
        return c.json({ message, error: message }, seasonParam ? 404 : 503);
    }

    const picked = [
        ...new Set(
            (c.req.query('with') ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter((s) => USER_ID.test(s) && s !== id),
        ),
    ].slice(0, MAX_OPPONENTS);

    try {
        // ranks and default opponents: the season's leaderboard, the live one for "all"
        const boardSeason = season ?? live;
        const entry = boardSeason ? await ensureLeaderboard(boardSeason) : null;
        const board = new Map(
            (entry?.players ?? []).map((p, i) => [
                extractUserId(p.profile),
                { rank: i + 1, name: p.displayName },
            ]),
        );
        const input = (userId: string): OpponentInput => ({
            userId,
            rank: board.get(userId)?.rank ?? null,
            name: board.get(userId)?.name,
        });

        let opponents = picked;
        if (opponents.length === 0) {
            if (!entry) {
                const message = "The leaderboard isn't available yet. Try again in a minute.";
                return c.json({ message, error: message }, 503);
            }
            opponents = [...board.keys()].filter((u) => u !== id).slice(0, MAX_OPPONENTS);
        }

        const data = await headToHead(season?.seasonId ?? null, id, opponents.map(input));
        c.header('Cache-Control', 'public, max-age=60');
        return c.json({
            ...data,
            userId: id,
            season: season ? season.seasonId : 'all',
            seasonName: season ? season.name : 'All seasons',
        });
    } catch (error) {
        logger.error(`Head to head of ${id} failed: ${error}`);
        const message = 'Could not compute the head to head.';
        return c.json({ message, error: message }, 500);
    }
});

export const VERSUS_TOPS = [10, 25, 50, 100] as const;

/** ?season=46 | all → the seasons asked for, newest last; null when unknown. */
async function resolveSeasons(param: string | undefined) {
    if (param === 'all') {
        const stored = await listMatchSeasons();
        return stored.map((id) => getSeasonById(id) ?? { seasonId: id, name: `Season ${id + 1}` });
    }
    const season = param ? getSeasonById(Number(param)) : getLiveSeason();
    return season ? [season] : null;
}

/**
 * GET /users/:id/versus: only the games the player played against these opponents
 *   ?season=46 | all      default: live season
 *   &vs=<id>              one opponent, with the latest games between them
 *   &top=10|25|50|100     or: the top N of each season, counted in that season (default 10)
 */
users.get('/:id/versus', async (c) => {
    const id = c.req.param('id');
    if (!USER_ID.test(id)) return invalid(c);
    const seasonParam = c.req.query('season');
    const seasons = await resolveSeasons(seasonParam);
    if (!seasons) {
        const message = 'Unknown season';
        return c.json({ message, error: message }, 404);
    }

    const vs = c.req.query('vs');
    if (vs !== undefined && (!USER_ID.test(vs) || vs === id)) {
        const message = 'Invalid opponent';
        return c.json({ message, error: message }, 400);
    }
    const topParam = Number(c.req.query('top') ?? 10);
    const top = (VERSUS_TOPS as readonly number[]).includes(topParam) ? topParam : 10;

    try {
        // one season: make sure its leaderboard is loaded (ranks, top N)
        if (seasons.length === 1) {
            const season = getSeasonById(seasons[0].seasonId);
            if (season) await ensureLeaderboard(season);
        }

        const missing: number[] = [];
        const groups: VersusSeason[] = seasons.map((season) => {
            if (vs) {
                return {
                    seasonId: season.seasonId,
                    name: season.name,
                    opponents: [{ userId: vs, rank: getSeasonRank(season.seasonId, vs) }],
                };
            }
            const players = getTopPlayers(season.seasonId, top);
            if (!players) missing.push(season.seasonId);
            return { seasonId: season.seasonId, name: season.name, opponents: players ?? [] };
        });

        const data = await versus(id, groups, {
            withMatches: !!vs,
            cacheKey: `${seasonParam ?? 'live'}:${vs ?? `top${top}`}`,
        });
        c.header('Cache-Control', 'public, max-age=60');
        return c.json({
            ...data,
            userId: id,
            season: seasonParam === 'all' ? 'all' : seasons[0].seasonId,
            seasonName: seasonParam === 'all' ? 'All seasons' : seasons[0].name,
            mode: vs ? 'player' : 'top',
            vs: vs ?? null,
            top: vs ? null : top,
            /** seasons whose leaderboard the server doesn't have yet (top N mode) */
            missingSeasons: missing,
        });
    } catch (error) {
        logger.error(`Versus of ${id} failed: ${error}`);
        const message = 'Could not compute the head to head.';
        return c.json({ message, error: message }, 500);
    }
});

/** GET /users/:id/opponents?season=46|all: everyone the player met, most games first. */
users.get('/:id/opponents', async (c) => {
    const id = c.req.param('id');
    if (!USER_ID.test(id)) return invalid(c);
    const seasons = await resolveSeasons(c.req.query('season'));
    if (!seasons) {
        const message = 'Unknown season';
        return c.json({ message, error: message }, 404);
    }
    try {
        const opponents = await opponentsMet(
            id,
            seasons.map((s) => s.seasonId),
        );
        c.header('Cache-Control', 'public, max-age=60');
        return c.json({ opponents });
    } catch (error) {
        logger.error(`Opponents of ${id} failed: ${error}`);
        const message = 'Could not list the opponents.';
        return c.json({ message, error: message }, 500);
    }
});

users.get('/:id/ranks', (c) => {
    const id = c.req.param('id');
    if (!USER_ID.test(id)) return invalid(c);
    return c.json(getRankHistory(id));
});

users.get('/:id/matches', proxy('matches'));
users.get('/:id', proxy('profile'));
