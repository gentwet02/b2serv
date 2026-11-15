/**
 * Hand-kept player tags. A map gives user id → the name to show when `playerNames` has no
 * alias; a set holds ids only, for tags where NK's display name is enough.
 */
export const CHEATERS = new Set<string>([
    '9fee14dddc96a8ac4b4a8b4c0a75e074c4514bbacb148d6a',
    '9fee418dd892f8a21b428e1e0972e67e98501be89f11dd3e',
]);

export const NUKERS: { [userId: string]: string } = {
    '9fee44ddddc3ffa54e40881f0a73e3719a0c1ae8cf45896a': 'Crisis_alt',
};

export const BOOSTERS: { [userId: string]: string } = {
    '9fb9158fd9c0f0a31a4a8e4d5c70e523cd521dbf96178e6c': 'Crisis',
};

export const HACKED: { [userId: string]: string } = {
    '9fbe45dadbc7acf71d4087180d71e371980c4ee998178c39': 'Meem',
    '9fbd10da8dc0fbad1c408d1a5627e321cc0749ef9c43dd6b': 'Onesks',
};

export const SUSPICIOUS: { [userId: string]: string } = {
    //'9fba43888ec3faf049408e485826e277cb0d4feeca448d3f': 'TurtleTime',
};

/** A search finds a tag from this many characters, typed from its start ("nuk" for nuker). */
export const TAG_SEARCH_MIN_LENGTH = 3;

/** Each tag's list. A player on several lists gets the first one. */
export const PLAYER_TAGS = {
    cheater: CHEATERS,
    nuker: NUKERS,
    booster: BOOSTERS,
    suspicious: SUSPICIOUS,
    hacked: HACKED,
} as const;
