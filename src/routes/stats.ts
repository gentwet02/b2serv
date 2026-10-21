import { Hono } from 'hono';
import { loadCodeBook, playerCodeOf, playerOf } from '@/services/codeBook';
import { getLeaderboardSize, getRankRange, readLeaderboard } from '@/services/leaderboard';
import { rangeBounds, resolveSeasons, VERSUS_RANGES, type VersusRange } from '@/services/ranges';
import { getSeasonById } from '@/services/seasons';
import { computeStats, type StatsSeasonGroup } from '@/services/stats';
import { playerNames } from '@/data/playerNames';
import { logger } from '@/utils/logger';
import { parseMapFilter } from '@/utils/matchLabels';

export const stats = new Hono();

const USER_ID = /^[a-z0-9]{8,64}$/i;
const NAME = /^[A-Za-z0-9_]{1,40}$/;
const PLAYER_SCOPES = VERSUS_RANGES;
type PlayerScope = (typeof PLAYER_SCOPES)[number];

/** Answers computed in the last 2 minutes (the cubes behind them are cached longer). */
const RESPONSE_TTL_MS = 2 * 60_000;
const responses = new Map<string, { data: unknown; expires: number }>();

/**
 * GET /stats: hero, tower, strat and map usage and win rates, from a group's side
 *   ?season=46 | all       default: live season
 *   &player=<id>           one player's games
 *   &players=t10|t25|t50|t100|t25p|t50p|t75p|all
 *                          or a range of each season's leaderboard (default t25);
 *   &band=1                only the ranks between the previous threshold and this one
 *   &map=oasis             a map key, both versions; oasis:classic | oasis:reversed for one
 *   &hero=Quincy           a hero base
 *   &towers=Druid,Ninja    up to 3, all in the loadout
 */
stats.get('/', async (c) => {
    const seasonParam = c.req.query('season');
    const seasons = await resolveSeasons(seasonParam);
    if (!seasons) {
        const message = 'Unknown season';
        return c.json({ message, error: message }, 404);
    }

    const playerParam = c.req.query('player');
    const userId = playerParam && USER_ID.test(playerParam) ? playerParam : undefined;
    const scopeParam = c.req.query('players') ?? 't25';
    const scope: PlayerScope = (PLAYER_SCOPES as readonly string[]).includes(scopeParam)
        ? (scopeParam as PlayerScope)
        : 't25';
    const band = !userId && c.req.query('band') === '1';
    // "oasis" (classic and reversed), "oasis:classic" or "oasis:reversed"
    const map = parseMapFilter(c.req.query('map'));
    // "Quincy" (any variant) or "Quincy:Quincy_Cyber", like /matches-history
    const [heroBase, heroVariant] = (c.req.query('hero') ?? '').split(':');
    const hero =
        heroBase && NAME.test(heroBase)
            ? heroVariant && NAME.test(heroVariant)
                ? { base: heroBase, hero: heroVariant }
                : { base: heroBase }
            : undefined;
    const towers = [
        ...new Set(
            (c.req.query('towers') ?? '')
                .split(',')
                .map((t) => t.trim())
                .filter((t) => NAME.test(t)),
        ),
    ].slice(0, 3);

    const cacheKey = JSON.stringify([
        seasonParam ?? 'live',
        userId ?? scope,
        band,
        map,
        hero,
        towers,
    ]);
    const hit = responses.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
        c.header('Cache-Control', 'public, max-age=60');
        return c.json(hit.data as object);
    }

    try {
        await loadCodeBook();
        if (seasons.length === 1 && !userId) {
            const season = getSeasonById(seasons[0]!.seasonId);
            if (season) await readLeaderboard(season);
        }

        const missing: number[] = [];
        const playerCode = userId ? playerCodeOf(userId) : undefined;
        const groups: (StatsSeasonGroup & {
            name: string;
            bounds: { from: number; to: number; size: number } | null;
        })[] = seasons.map((season) => {
            const base = { seasonId: season.seasonId, name: season.name, bounds: null };
            if (userId) {
                return {
                    ...base,
                    codes: playerCode === undefined ? [] : [playerCode],
                    groupKey: `p:${playerCode ?? userId}`,
                };
            }
            const size = getLeaderboardSize(season.seasonId);
            if (size === null) {
                missing.push(season.seasonId);
                return { ...base, codes: [], groupKey: 'none' };
            }
            const bounds = rangeBounds(scope as VersusRange, band, size);
            const codes = (getRankRange(season.seasonId, bounds.from, bounds.to) ?? [])
                .map((p) => playerCodeOf(p.userId))
                .filter((code): code is number => code !== undefined);
            return { ...base, bounds, codes, groupKey: `${scope}${band ? ':band' : ''}:${size}` };
        });

        const data = await computeStats({ seasons: groups, map, hero, towers });
        const body = {
            ...data,
            season: seasonParam === 'all' ? 'all' : seasons[0]!.seasonId,
            seasonName: seasonParam === 'all' ? 'All seasons' : seasons[0]!.name,
            mode: userId ? 'player' : 'top',
            players: userId ? null : scope,
            band,
            player: userId
                ? {
                      userId,
                      name: playerCode !== undefined ? (playerOf(playerCode)?.n ?? null) : null,
                      alias: playerNames[userId] ?? null,
                  }
                : null,
            filters: {
                map: map ? (map.variant ? map : { base: map.base }) : null,
                hero: hero ?? null,
                towers,
            },
            seasons: groups.map(({ seasonId, name, bounds, codes }) => ({
                seasonId,
                name,
                bounds,
                players: codes === null ? null : codes.length,
            })),
            /** seasons whose leaderboard the server doesn't have yet (range mode) */
            missingSeasons: missing,
        };
        if (responses.size > 300) responses.clear();
        responses.set(cacheKey, { data: body, expires: Date.now() + RESPONSE_TTL_MS });
        c.header('Cache-Control', 'public, max-age=60');
        return c.json(body);
    } catch (error) {
        logger.error(`Stats failed (${cacheKey}): ${error}`);
        const message = 'Could not compute the stats.';
        return c.json({ message, error: message }, 500);
    }
});
