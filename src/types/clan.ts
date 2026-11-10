import type { NkUserId } from '@/types/ninjakiwi';
import type { PlayerTag } from '@/types/player';

/** A clan (NK calls them guilds) as the API serves it. */
export interface Clan {
    id: string;
    name: string;
    bannerURL: string | null;
    tagline: string | null;
    /** every member, as NK counts them */
    members: number;
    status: string;
    ownerId: string | null;
    /** the owner's name, when they are a player we know */
    ownerName: string | null;
}

/** A clan in the clans list: enough to pick one. */
export interface ClanSummary {
    id: string;
    name: string;
    bannerURL: string | null;
    members: number;
    /** members we know: the players we read profiles of (HoM) */
    known: number;
}

/** A known member of a clan. */
export interface ClanMember {
    userId: NkUserId;
    name: string | null;
    alias: string | null;
    tag: PlayerTag | null;
    /** rank and score in the live season's leaderboard */
    rank: number | null;
    score: number | null;
    /** best rank and best score in any season's leaderboard, the live one included */
    bestRank: number | null;
    bestScore: number | null;
    /** their rank in every season they ranked in, best first: what breaks a tie on the best */
    ranks: number[];
}
