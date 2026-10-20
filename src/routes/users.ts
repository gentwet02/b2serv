import { Hono, type Context } from 'hono';
import { getConnInfo } from 'hono/bun';
import {
    readLeaderboard,
    getRankHistory,
    getLeaderboardSize,
    getRankRange,
    getSeasonRank,
} from '@/services/leaderboard';
import {
    getPlayerSeasonRecords,
    getSeasonStats,
    headToHead,
    listMatchSeasons,
    OpponentInput,
    opponentsMet,
    versus,
} from '@/services/matchStore';
import { getLiveMatches } from '@/services/liveMatches';
import { getProfileSeason, getStoredProfile } from '@/services/profileStore';
import { getLiveSeason, getSeasonById } from '@/services/seasons';
import { logger } from '@/utils/logger';
import { fixAssetUrl, fixProfileAssets } from '@/utils/assets';
import { extractUserId } from '@/utils/helpers';
import { VersusSeason } from '@/types/season';

/**
 * Player data for the client, from the database (background jobs keep it up to date).
 * The one exception, /:id/matches, is rate limited (services/liveMatches.ts).
 *
 * GET /users/:id           stored profile (NK body + our season records), never asks NK
 * GET /users/:id/matches   NK's latest matches (fallback when we stored none), rate limited
 * GET /users/:id/season    season record: stored matches (W/D/L, heroes) + stored profile (streaks)
 * GET /users/:id/seasons   W/D/L in every stored season, from the stored matches
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

/** The visitor's address: the proxy's header when there is one, else the connection. */
function clientIp(c: Context) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
    try {
        return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

async function recentMatches(c: Context) {
    const id = c.req.param('id') ?? '';
    if (!USER_ID.test(id)) return invalid(c);

    const result = await getLiveMatches(id, clientIp(c));
    switch (result.status) {
        case 'unknown': {
            const message = "We don't track this player.";
            return c.json({ message, error: 'not_found' }, 404);
        }
        case 'busy': {
            const seconds = Math.ceil(result.retryAfterMs / 1000);
            c.header('Retry-After', String(seconds));
            const message = `Too many requests right now. Try again in ${seconds}s.`;
            return c.json({ message, error: 'rate_limited' }, 429);
        }
        case 'unavailable': {
            const message = "Ninja Kiwi's API didn't answer. Try again in a moment.";
            return c.json({ message, error: 'upstream_unavailable' }, 502);
        }
    }
    const { data, fetchedAt } = result.entry;
    if (!data.success) {
        const message = data.error || 'Player not found';
        return c.json({ message, error: message }, 404);
    }
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ ...data, fetchedAt: new Date(fetchedAt).toISOString() });
}

/** Asset links inside a season record, with dead animated links replaced. */
function fixSeasonAssets<T extends { equipped: Record<string, unknown> }>(season: T): T {
    const equipped = { ...season.equipped };
    for (const key of ['avatar', 'banner', 'border'] as const) {
        if (typeof equipped[key] === 'string') equipped[key] = fixAssetUrl(equipped[key]);
    }
    return { ...season, equipped };
}

async function storedProfile(c: Context) {
    const id = c.req.param('id') ?? '';
    if (!USER_ID.test(id)) return invalid(c);
    try {
        const stored = await getStoredProfile(id);
        if (!stored) {
            const message = 'We have no profile stored for this player yet.';
            return c.json({ message, error: 'not_found', success: false }, 404);
        }
        const { seasons, ...body } = stored.body;
        const data = fixProfileAssets({ success: true, error: null, body });
        c.header('Cache-Control', 'public, max-age=60');
        return c.json({
            ...data,
            seasons: seasons.map(fixSeasonAssets),
            fetchedAt: stored.fetchedAt.toISOString(),
        });
    } catch (error) {
        logger.error(`Stored profile of ${id} failed: ${error}`);
        const message = 'Could not load this profile.';
        return c.json({ message, error: message }, 500);
    }
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
        const [stats, record] = await Promise.all([
            getSeasonStats(id, season.seasonId),
            getProfileSeason(id, season.seasonId),
        ]);
        // streaks come from the profile readings: the stored matches miss games (only HoM
        // vs HoM, NK's 24-match window), which split or join streaks
        return c.json({
            ...stats,
            winStreak: record?.winStreak ?? null,
            bestWinStreak: record?.bestWinStreak ?? null,
            record: record ? fixSeasonAssets(record) : null,
            seasonName: season.name,
        });
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
        const entry = boardSeason ? await readLeaderboard(boardSeason) : null;
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
            if (season) await readLeaderboard(season);
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

/** GET /users/:id/seasons: wins, draws, losses per season, newest first (stored matches). */
users.get('/:id/seasons', async (c) => {
    const id = c.req.param('id');
    if (!USER_ID.test(id)) return invalid(c);
    try {
        c.header('Cache-Control', 'public, max-age=60');
        return c.json({ seasons: await getPlayerSeasonRecords(id) });
    } catch (error) {
        logger.error(`Season records of ${id} failed: ${error}`);
        const message = 'Could not load the season records.';
        return c.json({ message, error: message }, 500);
    }
});

users.get('/:id/ranks', (c) => {
    const id = c.req.param('id');
    if (!USER_ID.test(id)) return invalid(c);
    return c.json(getRankHistory(id));
});

users.get('/:id/matches', recentMatches);
users.get('/:id', storedProfile);
