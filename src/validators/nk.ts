import {
    NK_API_BASE_URL,
    NK_ASSET_URL_PREFIX,
    NK_GUILD_ID,
    NK_GUILD_URL_PREFIX,
    NK_USER_ID,
    NK_USER_URL_PREFIX,
} from '@/config/nk';
import type {
    NkApi,
    NkAssetUrl,
    NkGuildId,
    NkGuildUrl,
    NkProfileUrl,
    NkUserId,
} from '@/types/ninjakiwi';

export function isNkUserId(id: string): id is NkUserId {
    return NK_USER_ID.test(id);
}

export function isNkGuildId(id: string): id is NkGuildId {
    return NK_GUILD_ID.test(id);
}

/** A link to NK's data API ("https://data.ninjakiwi.com/battles2/…"). */
export function isNkApiUrl(url: string): url is NkApi {
    return url.startsWith(`${NK_API_BASE_URL}/`);
}

/** A link to a player whose id is a valid user id. */
export function isNkProfileUrl(url: string): url is NkProfileUrl {
    return url.startsWith(NK_USER_URL_PREFIX) && isNkUserId(url.slice(NK_USER_URL_PREFIX.length));
}

export function isNkGuildUrl(url: string): url is NkGuildUrl {
    return url.length > NK_GUILD_URL_PREFIX.length && url.startsWith(NK_GUILD_URL_PREFIX);
}

/** A picture on NK's usual asset host. NK sometimes uses others: don't reject those. */
export function isNkAssetUrl(url: string): url is NkAssetUrl {
    return url.startsWith(NK_ASSET_URL_PREFIX);
}
