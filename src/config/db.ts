export const COLLECTIONS = {
    LEADERBOARDS: 'leaderboards',
    PROFILES: 'player_profiles',
    CLANS: 'clans',
    /** who is in each clan, from the stored profiles (services/clanMembers.ts) */
    CLAN_MEMBERS: 'clan_members',
    CODES: 'codes',
    PLAYER_CODES: 'player_codes',
    NK_ASSETS: 'nk_assets',
    LEAGUES: 'leagues',
    /** One collection of matches per season. */
    MATCHES: (seasonId: number) => `matches_s${seasonId}`,
} as const;

/** Matches a COLLECTIONS.MATCHES name, the season id captured. */
export const MATCHES_COLLECTION_NAME = /^matches_s(\d+)$/;
