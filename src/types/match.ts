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
