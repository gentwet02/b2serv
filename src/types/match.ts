import type mongoose from 'mongoose';
import type { GAME_RESULTS, GAME_TYPES, MATCH_SORTS } from '@/config/matches';
import type { KnownOr, NkProfileUrl, NkUserId } from '@/types/ninjakiwi';
import type { Hero, HeroBase, Tower } from '@/types/towers';

export type GameResult = (typeof GAME_RESULTS)[number];
export type GameType = (typeof GAME_TYPES)[number];

export type MapVariant = 'classic' | 'reversed';
/** A parsed map filter: a map key, both versions or one ("oasis:reversed"). */
export interface MapFilter {
    base: string;
    variant?: MapVariant | undefined;
}

/** A value of an NK match missing from config/, as "tower: NewMonkey" (see matchIssues). */
export type MatchIssue = `${'game type' | 'hero' | 'tower' | 'result'}: ${string}`;

export interface MatchPlayer {
    displayName: string;
    hero: KnownOr<Hero>;
    heroPortrait?: string;
    towerone: KnownOr<Tower>;
    towertwo: KnownOr<Tower>;
    towerthree: KnownOr<Tower>;
    currentUser?: boolean;
    result: KnownOr<GameResult>;
    profileURL: NkProfileUrl;
}

export interface Match {
    id: string;
    gametype: KnownOr<GameType>;
    map: string;
    duration: number;
    endRound: number;
    mapURL?: string;
    league?: string;
    playerLeft: MatchPlayer;
    playerRight: MatchPlayer;
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
    base: KnownOr<HeroBase>;
    hero?: KnownOr<Hero>;
}

export interface MatchesFilter {
    /** null: every stored season */
    seasonId: number | null;
    offset: number;
    limit: number;
    sort: MatchSort;
    player?: string; // part of a name (in-game or real)
    playerId?: NkUserId; // exact user id
    allNames: boolean; // player / player2 also match the names players had before
    heroes: HeroPick[]; // up to 2
    towers: KnownOr<Tower>[]; // up to 6
    map?: string; // map key
    /**
     * "Same player" mode: player, hero and towers above describe one side of the match,
     * player2, heroes2 and towers2 the other side (≤ 1 hero and ≤ 3 towers per side).
     * Either side can be left empty.
     */
    sameSide: boolean;
    player2?: string; // same player mode only: part of the other side's name
    heroes2: HeroPick[]; // same player mode only: ≤ 1
    towers2: KnownOr<Tower>[]; // same player mode only: ≤ 3
    /** Exclusions: no player uses these (same player mode: side 1 doesn't). */
    exHeroes: HeroPick[];
    exTowers: KnownOr<Tower>[];
    /** map keys, like `map`: none of these maps (or versions) */
    exMaps: string[];
    /** same player mode only: side 2 doesn't use these */
    exHeroes2: HeroPick[];
    exTowers2: KnownOr<Tower>[];
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
    /** The searched players' codes (null: no search): player 1's, and in same player mode 2's. */
    players: [one: number[] | null, two: number[] | null];
}

/** Which stored player a match list puts first when the viewer keeps sides. */
export type MatchSide = 'left' | 'right';

/** Heroes and towers available for one side (or both sides when not split). */
export interface SideOptions {
    heroes: {
        base: KnownOr<HeroBase>;
        count: number;
        variants: { hero: KnownOr<Hero>; count: number; portrait?: string }[];
    }[];
    towers: { tower: KnownOr<Tower>; count: number }[];
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
        variants: { variant: MapVariant; count: number }[];
    }[];
}
