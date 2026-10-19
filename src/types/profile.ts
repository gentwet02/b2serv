import type mongoose from 'mongoose';

/** Ranked or casual stats, as NK sends them. */
export interface NkStats {
    wins: number;
    draws: number;
    losses: number;
    win_streak: number;
    highest_win_streak: number;
    no_lives_lost: number;
    first_bloons: number;
}

export interface NkBadge {
    season?: number;
    name?: string;
    iconURL?: string;
}

/**
 * GET /battles2/users/:id body, the fields we keep. Old dumps miss some of them
 * (no equippedTitle, no accolades), so everything is optional.
 */
export interface NkProfileBody {
    displayName?: string;
    is_vip?: boolean;
    is_club_member?: boolean;
    equippedAvatar?: string;
    equippedAvatarURL?: string;
    equippedBanner?: string;
    equippedBannerURL?: string;
    equippedBorder?: string;
    equippedBorderURL?: string;
    equippedTitle?: string;
    casualStats?: Partial<NkStats>;
    rankedStats?: Partial<NkStats>;
    badges_equipped?: unknown[];
    chestsOpened?: number;
    currentSeason?: string;
    currentSeason_highestArena?: string;
    currentSeason_highestArenaIndex?: number;
    currentSeason_trophies?: number;
    lifetime_highestArena?: string;
    lifetime_highestArenaIndex?: number;
    lifetime_trophies?: number;
    arenaLeagueTier?: number;
    inGuild?: boolean;
    guild?: string | null;
    accolades?: { type?: string; subtype?: string; value?: number }[];
    _bloonStats?: { bloon_type?: string; sends?: number; pops?: number }[];
    _towers?: { type?: string; used?: number; unlocked?: boolean }[];
}

/** Lifetime ranked numbers at one point in time: [wins, draws, losses, win streak, best win streak] */
export type RankedPoint = [number, number, number, number, number];

/**
 * One season of a player, in `player_profiles.s`. Ranked stats never reset on NK's side,
 * so the season record is the difference between two lifetime readings (see profileFormat.ts).
 */
export interface ProfileSeasonDoc {
    /** season id */
    i: number;
    /** first and last reading taken during the season */
    t0: Date;
    t1: Date;
    /** lifetime ranked numbers at the first and last reading */
    r0: RankedPoint;
    r1: RankedPoint;
    /** best win streak of the season (never lower than the truth we could see) */
    bw: number;
    /** equipped at the last reading: [avatar, banner, border, title] codes, -1 = none */
    e: number[];
    /** equipped badges at the last reading: [season + 1, badge code, …] */
    g?: number[];
}

/**
 * A player's profile, unpacked (what the code works with). Stored packed as a
 * StoredProfileDoc, see profileFormat.ts (pack / unpack).
 */
export interface ProfileDoc {
    _id: number;
    /** when the latest reading was taken */
    t: Date;
    /** equipped [avatar, banner, border, title], -1 = none */
    e: number[];
    /** equipped badges [season + 1, badge code, …] */
    g?: number[];
    /** 1 vip, 2 club member, 4 in a guild */
    f: number;
    /** guild code */
    gu?: number;
    /** ranked and casual [wins, draws, losses, win streak, best win streak, no lives lost, first bloons] */
    r: number[];
    c: number[];
    /**
     * [NK season number + 1 (0 = none), season trophies, season arena code + 1, season arena index,
     *  lifetime trophies, lifetime arena code + 1, lifetime arena index, league tier, chests opened]
     */
    a: number[];
    /** varints: (unit code, used × 2 + unlocked)… */
    u?: mongoose.mongo.Binary;
    /** varints: (bloon code, sends, pops)… */
    b?: mongoose.mongo.Binary;
    /** varints: (type code, subtype code, value)… */
    k?: mongoose.mongo.Binary;
    /** seasons, oldest first */
    s: ProfileSeasonDoc[];
}

/**
 * `player_profiles`: one document per player, keyed by the player code (player_codes).
 * Every repeated string is a code (codes collection), numbers are packed as varints.
 *   v   current numbers (layout in profileFormat.ts, packCurrent)
 *   u/b/k  towers, bloons, accolades (same as ProfileDoc)
 *   s   one Binary per season, oldest first (packSeason)
 */
export interface StoredProfileDoc {
    _id: number;
    t: Date;
    v: mongoose.mongo.Binary;
    u?: mongoose.mongo.Binary;
    b?: mongoose.mongo.Binary;
    k?: mongoose.mongo.Binary;
    s?: mongoose.mongo.Binary[];
}

/** A season record as the API serves it. */
export interface ProfileSeason {
    seasonId: number;
    wins: number;
    draws: number;
    losses: number;
    winStreak: number;
    bestWinStreak: number;
    /**
     * false when the record starts at our first reading of the player in that season, not at
     * the end of their previous season: games played before it are missing.
     */
    complete: boolean;
    equipped: {
        avatar: string | null;
        banner: string | null;
        border: string | null;
        title: string | null;
        badges: { season: number | null; name: string; iconURL: string | null }[];
    };
    firstSeen: string;
    lastSeen: string;
}
