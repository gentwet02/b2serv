import type { MATCH_SORTS } from '@/config/constants';
import type mongoose from 'mongoose';

export interface MatchPlayer {
    displayName: string;
    hero: string;
    heroPortrait?: string;
    towerone: string;
    towertwo: string;
    towerthree: string;
    currentUser?: boolean;
    result: string;
    profileURL: string;
}

export interface Match {
    id: string;
    gametype: string;
    map: string;
    duration: number;
    endRound: number;
    mapURL?: string;
    playerLeft: MatchPlayer;
    playerRight: MatchPlayer;
}

export interface MatchPlayerDocument {
    i: string;
    t: number;
}

export interface MatchDocument {
    _id?: string;
    t: number;
    i: string;
    d: number;
    pl: MatchPlayerDocument;
    pr: MatchPlayerDocument;
}

export interface CachedMatches {
    lastUpdated: Date;
    totalMatches: number;
    matches: Match[];
    seasonID: number;
}

export interface StoredMatchDoc {
    _id: string | mongoose.mongo.Binary;
    t: number;
    a: number;
    b: number;
    x: number;
    y: number;
    d: number;
}

/** A hero filter: any variant of `base`, or exactly `hero`. */
export interface HeroPick {
    base: string;
    hero?: string;
}

export interface MatchesFilter {
    seasonId: number;
    offset: number;
    limit: number;
    sort: MatchSort;
    player?: string; // part of a name (in-game or real)
    playerId?: string; // exact user id
    heroes: HeroPick[]; // up to 2
    towers: string[]; // up to 6
    map?: string; // map key
    /** player, hero and towers on the same side (only with ≤ 1 hero and ≤ 3 towers) */
    sameSide: boolean;
}

export type FacetFilter = Omit<MatchesFilter, 'offset' | 'limit' | 'sort'>;

export type MatchSort = (typeof MATCH_SORTS)[number];

export interface BuiltQuery {
    match: Record<string, unknown>;
    /** with "same player": which side satisfies the side conditions (aggregation expressions) */
    sideOk: [object, object] | null;
}

export interface FilterOptions {
    heroes: {
        base: string;
        count: number;
        variants: { hero: string; count: number; portrait?: string }[];
    }[];
    towers: { tower: string; count: number }[];
    maps: { key: string; map: string; count: number }[];
}
