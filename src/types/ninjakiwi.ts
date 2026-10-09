import type { Match } from './match';

export type NkApi = `https://data.ninjakiwi.com/battles2/${string}`;

export interface NinjaKiwiResponse<T> {
    body: T;
    next?: boolean;
}

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
    hasHistory: (userId: string) => Promise<boolean>;
}

export interface HistoryOptions extends StoreLookup {
    filter: (match: Match) => boolean;
}

/**
 * One read of a player's matches. NK only serves the last ~24 matches, with no paging.
 */
export interface PlayerHistory {
    /** matches that passed the filter, newest first */
    matches: Match[];
    /** false: the request failed — read this player again later */
    ok: boolean;
    /**
     * true: we already knew this player but none of the returned matches is stored,
     * so they played past NK's window since our last read and older matches are lost.
     */
    gap: boolean;
}

export interface CrawlOptions extends StoreLookup {
    filter?: (match: Match) => boolean;
    concurrency?: number;
    onProgress?: (matches: Map<string, Match>, progress: CrawlProgress) => void;
}

export interface CrawlResult {
    matches: Map<string, Match>;
    /** players with a failed request: read them again */
    failed: string[];
    /** players whose window overflowed since the last read (see PlayerHistory.gap) */
    gaps: string[];
}
