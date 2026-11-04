import type { NkGuildUrl, NkProfileUrl, NkUserId } from '@/types/ninjakiwi';

export const NK_API_BASE_URL = 'https://data.ninjakiwi.com/battles2';
/** How NK links to a player or a guild in its answers (the id follows). */
export const NK_USER_URL_PREFIX = `${NK_API_BASE_URL}/users/` as const;
export const NK_GUILD_URL_PREFIX = `${NK_API_BASE_URL}/guild/` as const;
/** NK's usual host for avatars, banners, borders and badges. */
export const NK_ASSET_URL_PREFIX = 'https://static-api.nkstatic.com/appdocs/4/assets/opendata/';

export const NK_API = {
    LEADERBOARD: (seasonId: number, page?: number) =>
        `${NK_API_BASE_URL}/homs/season_${seasonId}/leaderboard${page ? `?page=${page}` : ''}`,
    PLAYER_MATCHES: (userId: NkUserId) => `${NK_USER_URL_PREFIX}${userId}/matches`,
    PLAYER_PROFILE: (userId: NkUserId): NkProfileUrl => `${NK_USER_URL_PREFIX}${userId}`,
    GUILD: (guildId: string): NkGuildUrl => `${NK_GUILD_URL_PREFIX}${guildId}`,
    SEASONS: `${NK_API_BASE_URL}/homs`,
} as const;

/** NK user ids: 48 alphanumeric chars. validators/nk.ts isNkUserId checks one. */
export const NK_USER_ID = /^[a-z0-9]{48}$/i;
