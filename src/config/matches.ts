export const MATCH_SORTS = ['newest', 'oldest', 'longest', 'shortest', 'rounds'] as const;
/** A hero, tower or map name in a query parameter. */
export const NAME_PARAM = /^[A-Za-z0-9_]{1,40}$/;
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
    'upontheroof',
]);
