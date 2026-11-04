/** Every result NK gives a match side. */
export const GAME_RESULTS = [
    'cancelled',
    'draw',
    'lobbyDC',
    'lose',
    'opponentLobbyDC',
    'win',
] as const;
export const GAME_TYPES = ['Casual', 'Event', 'GuildWar', 'Ranked'] as const;

export const MATCH_SORTS = ['newest', 'oldest', 'longest', 'shortest', 'rounds'] as const;
export const MAX_HEROES = 2;
export const MAX_TOWERS = 6;
/** Exclusions: none of these in the match (or on that side, in same player mode). */
export const MAX_EX_HEROES = 6;
export const MAX_EX_TOWERS = 10;
export const MAX_EX_MAPS = 10;

/**
 * Maps only played outside of Hall of Masters (map keys, see mapBaseKey). NK's match history
 * mixes in some non-HoM games we can't tell apart; matches on these maps are dropped at least.
 */
export const NON_HOM_MAPS: ReadonlySet<string> = new Set([
    'bloontoniummines',
    'docks',
    'inthewall',
    'islandbase',
    'mayan',
]);
/**
 * Maps taken out of the HoM pool (map key: first season id without it). From that season on
 * they are only played outside HoM, so their matches are dropped like NON_HOM_MAPS.
 */
export const HOM_MAP_REMOVED_SEASON: Readonly<Record<string, number>> = {
    upontheroof: 29,
    thinice: 41,
    park: 43,
};
/**
 * Season ids when NK's match history wasn't limited to HoM (the client notes them). Their
 * non-HoM games can't all be told apart anyway, so no map is dropped there.
 * Mirrored in the client's config/seasons.ts (as shown numbers, id + 1): change both.
 */
export const UNFILTERED_SEASONS: ReadonlySet<number> = new Set([
    16, 17, 18, 19, 20, 39, 40, 41, 42,
]);
