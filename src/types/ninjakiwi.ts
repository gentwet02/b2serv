import { Match } from './match';

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

export interface CrawlProgress {
    done: number;
    total: number;
}

export interface CrawlOptions {
    isStored: (ids: string[]) => Promise<Set<string>>;
    filter?: (match: Match) => boolean;
    concurrency?: number;
    maxPages?: number;
    onProgress?: (matches: Map<string, Match>, progress: CrawlProgress) => void;
}

export interface CrawlResult {
    matches: Map<string, Match>;
    /** players with a failed request: read them again */
    failed: string[];
    /** players whose history went past maxPages without meeting a stored match */
    truncated: string[];
    pages: number;
}
