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
    /** all-seasons queries: the season the match was read from */
    s?: number;
}

/** A hero filter: any variant of `base`, or exactly `hero`. */
export interface HeroPick {
    base: string;
    hero?: string;
}

export interface MatchesFilter {
    /** null: every stored season */
    seasonId: number | null;
    offset: number;
    limit: number;
    sort: MatchSort;
    player?: string; // part of a name (in-game or real)
    playerId?: string; // exact user id
    allNames: boolean; // player / player2 also match the names players had before
    heroes: HeroPick[]; // up to 2
    towers: string[]; // up to 6
    map?: string; // map key
    /**
     * "Same player" mode: player, hero and towers above describe one side of the match,
     * player2, heroes2 and towers2 the other side (≤ 1 hero and ≤ 3 towers per side).
     * Either side can be left empty.
     */
    sameSide: boolean;
    player2?: string; // same player mode only: part of the other side's name
    heroes2: HeroPick[]; // same player mode only: ≤ 1
    towers2: string[]; // same player mode only: ≤ 3
    /** Exclusions: no player uses these (same player mode: side 1 doesn't). */
    exHeroes: HeroPick[];
    exTowers: string[];
    /** map keys, like `map`: none of these maps (or versions) */
    exMaps: string[];
    /** same player mode only: side 2 doesn't use these */
    exHeroes2: HeroPick[];
    exTowers2: string[];
}

export type FacetFilter = Omit<MatchesFilter, 'offset' | 'limit' | 'sort'>;

export type MatchSort = (typeof MATCH_SORTS)[number];

export interface BuiltQuery {
    match: Record<string, unknown>;
    /**
     * With "same player" (aggregation expressions): `straight` when side 1's filters fit the
     * left player and side 2's the right one, `swapped` for the other way round.
     */
    sides: { straight: object; swapped: object } | null;
}

/** Heroes and towers available for one side (or both sides when not split). */
export interface SideOptions {
    heroes: {
        base: string;
        count: number;
        variants: { hero: string; count: number; portrait?: string }[];
    }[];
    towers: { tower: string; count: number }[];
}

export interface FilterOptions extends SideOptions {
    /** same player mode: the options of side 1 and side 2 */
    sides?: [SideOptions, SideOptions];
    /** base maps: classic and reversed versions together, counted apart in `variants` */
    maps: {
        key: string;
        map: string;
        count: number;
        image: string | null;
        variants: { variant: 'classic' | 'reversed'; count: number }[];
    }[];
}
