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
    'park',
    'thinice',
]);
// seasons where filter was down/non-existant?
// 16-20, 39-42 (ids)
export const NON_HOM_MAPS_SEASON = {
    29: ['upontheroof'],
    43: ['park'],
} as const;
