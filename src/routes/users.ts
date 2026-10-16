import { Hono, type Context } from 'hono';
import {
    ensureLeaderboard,
    getRankHistory,
    getLeaderboardSize,
    getRankRange,
    getSeasonRank,
} from '@/services/leaderboard';
import {
    getSeasonStats,
    headToHead,
    listMatchSeasons,
    OpponentInput,
    opponentsMet,
    versus,
} from '@/services/matchStore';
import { getPlayerData } from '@/services/playerData';
import { getLiveSeason, getSeasonById } from '@/services/seasons';
import { logger } from '@/utils/logger';
import { fixProfileAssets } from '@/utils/assets';
import { extractUserId } from '@/utils/helpers';
import { VersusSeason } from '@/types/season';

/**
 * Player data for the client. The browser never calls Ninja Kiwi itself.
 *
 * GET /users/:id           NK profile (memory → MongoDB → NK, see services/playerData.ts)
 * GET /users/:id/matches   NK recent matches (fallback when we stored none)
 * GET /users/:id/season    season record from the stored matches
 * GET /users/:id/ranks     rank in every stored season, best end-of-season finish
 * GET /users/:id/compare   the player against the season's top 10, or ?with=id1,id2…
 * GET /users/:id/versus    head to head against one player or a leaderboard range
 * GET /users/:id/opponents everyone the player met, most games first
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

export const VERSUS_RANGES = ['t10', 't25', 't50', 't100', 't25p', 't50p', 't75p', 'all'] as const;
type VersusRange = (typeof VERSUS_RANGES)[number];

/** Players a range covers in a leaderboard of `size` players. */
function rangeCount(range: VersusRange, size: number) {
    if (range === 'all') return size;
    if (range.endsWith('p')) return Math.ceil((size * Number(range.slice(1, -1))) / 100);
    return Math.min(Number(range.slice(1)), size);
}

/**
 * Ranks a range covers in one season. `band`: only the ranks below the next smaller
 * threshold (top 25 → 11–25; top 25% of 1200 players → 101–300).
 */
function rangeBounds(range: VersusRange, band: boolean, size: number) {
    const to = rangeCount(range, size);
    if (!band) return { from: 1, to, size };
    const below = VERSUS_RANGES.map((r) => rangeCount(r, size)).filter((n) => n < to);
    return { from: (below.length ? Math.max(...below) : 0) + 1, to, size };
}

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
 *   &range=t10|t25|t50|t100|t25p|t50p|t75p|all
 *                         or: a range of each season's leaderboard, counted in that season
 *   &band=1               only the ranks between the previous threshold and this one
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
    const rangeParam = c.req.query('range') ?? 't10';
    const range: VersusRange = (VERSUS_RANGES as readonly string[]).includes(rangeParam)
        ? (rangeParam as VersusRange)
        : 't10';
    const band = c.req.query('band') === '1';

    try {
        // one season: make sure its leaderboard is loaded (ranks, ranges)
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
            const size = getLeaderboardSize(season.seasonId);
            if (size === null) {
                missing.push(season.seasonId);
                return { seasonId: season.seasonId, name: season.name, opponents: [] };
            }
            const bounds = rangeBounds(range, band, size);
            return {
                seasonId: season.seasonId,
                name: season.name,
                bounds,
                opponents: getRankRange(season.seasonId, bounds.from, bounds.to) ?? [],
            };
        });

        const data = await versus(id, groups, {
            withMatches: !!vs,
            cacheKey: `${seasonParam ?? 'live'}:${vs ?? `${range}${band ? ':band' : ''}`}`,
        });
        c.header('Cache-Control', 'public, max-age=60');
        return c.json({
            ...data,
            userId: id,
            season: seasonParam === 'all' ? 'all' : seasons[0].seasonId,
            seasonName: seasonParam === 'all' ? 'All seasons' : seasons[0].name,
            mode: vs ? 'player' : 'top',
            vs: vs ?? null,
            range: vs ? null : range,
            band: !vs && band,
            /** seasons whose leaderboard the server doesn't have yet (range mode) */
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
