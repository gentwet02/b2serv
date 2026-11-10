import type {
    NK_API_BASE_URL,
    NK_ASSET_URL_PREFIX,
    NK_GUILD_URL_PREFIX,
    NK_USER_URL_PREFIX,
} from '@/config/nk';
import type { Match } from './match';

export type NkApi = `${typeof NK_API_BASE_URL}/${string}`;
/** NK's link to a player ("…/battles2/users/<id>"); extractUserId reads the id back. */
export type NkProfileUrl = `${typeof NK_USER_URL_PREFIX}${string}`;
export type NkGuildUrl = `${typeof NK_GUILD_URL_PREFIX}${string}`;
/** A picture on NK's usual asset host. NK sometimes uses others, so asset fields stay string. */
export type NkAssetUrl = `${typeof NK_ASSET_URL_PREFIX}${string}`;

/** A user id checked with isNkUserId, or taken from one of NK's own links. */
export type NkUserId = string & { readonly __brand: 'NkUserId' };
/** A guild (clan) id checked with isNkGuildId. */
export type NkGuildId = string & { readonly __brand: 'NkGuildId' };

/**
 * A value NK usually sends, or a new one it added since (we keep those, see matchIssues).
 * Suggests the known values but stays a plain string: narrow with validators/ to rely on one.
 */
export type KnownOr<T extends string> = T | (string & {});

export interface Model {
    name: string;
    parameters: { [key: string]: string };
}

export interface CrawlProgress {
    done: number;
    total: number;
}

/** What the crawler asks the database. */
export interface StoreLookup {
    /** which of these match ids are already stored */
    isStored: (ids: string[]) => Promise<Set<string>>;
    /** whether at least one match of this player is already stored this season */
    hasHistory: (userId: NkUserId) => Promise<boolean>;
}

export interface HistoryOptions extends StoreLookup {
    filter: (match: Match) => boolean;
    /** the etag of the player's last read: an unchanged page is not processed again */
    etag?: string | null;
}

/** One NK read, with what Cloudflare said about its copy. */
export interface NkAnswer<T> {
    /** null when NK did not answer (after retries) or answered "unchanged" */
    data: T | null;
    /** unchanged: same etag as the one sent (a 304, or a 200 with the same etag) */
    status: 'ok' | 'unchanged' | 'failed';
    etag: string | null;
    /** how old Cloudflare's copy is, in seconds (the `age` header; null when absent) */
    ageS: number | null;
}

/** When a player's page is read next (services/readSchedule.ts). */
export interface ReadTiming {
    etag: string | null;
    nextFetchAt: number;
    lastFetchAt: number;
    /** the last time the player was on the roster */
    seenAt: number;
}

/** What a read tells its schedule. */
export interface ReadOutcome {
    /** false: NK did not answer, read again soon */
    ok: boolean;
    etag: string | null;
    ageS: number | null;
}

/**
 * One read of a player's matches. NK only serves the last ~24 matches, with no paging.
 */
export interface PlayerHistory {
    /** matches that passed the filter, newest first */
    matches: Match[];
    /** false: the request failed — read this player again later */
    ok: boolean;
    /** true: the page is the same as the last read, nothing was processed */
    unchanged: boolean;
    etag: string | null;
    ageS: number | null;
    /**
     * true: we already knew this player but none of the returned matches is stored,
     * so they played past NK's window since our last read and older matches are lost.
     */
    gap: boolean;
}

export interface CrawlOptions extends StoreLookup {
    filter?: (match: Match) => boolean;
    /** the etag of each player's last read */
    etagOf?: (userId: NkUserId) => string | null;
    /** called after each player's read, failed or not */
    onPlayer?: (userId: NkUserId, history: PlayerHistory) => void;
    concurrency?: number;
    onProgress?: (matches: Map<string, Match>, progress: CrawlProgress) => void;
}

export interface CrawlResult {
    matches: Map<string, Match>;
    /** players with a failed request: read them again */
    failed: NkUserId[];
    /** players whose window overflowed since the last read (see PlayerHistory.gap) */
    gaps: NkUserId[];
}
