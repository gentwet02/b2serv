/** Hand-kept player tags: user id → the name to show when `playerNames` has no alias. */
export const CHEATERS: { [userId: string]: string } = {
    '9fee14dddc96a8ac4b4a8b4c0a75e074c4514bbacb148d6a': 'Corrupt Eggs',
};

export const NUKERS: { [userId: string]: string } = {
    '9fee44ddddc3ffa54e40881f0a73e3719a0c1ae8cf45896a': 'Crisis_alt',
};

export const BOOSTERS: { [userId: string]: string } = {
    '9fb9158fd9c0f0a31a4a8e4d5c70e523cd521dbf96178e6c': 'Crisis',
};

/** A search finds a tag from this many characters, typed from its start ("nuk" for nuker). */
export const TAG_SEARCH_MIN_LENGTH = 3;

/** Each tag's list. A player on several lists gets the first one. */
export const PLAYER_TAGS = {
    cheater: CHEATERS,
    nuker: NUKERS,
    booster: BOOSTERS,
} as const;
