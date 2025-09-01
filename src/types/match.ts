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
    map?: string;
    mapName?: string;
    duration: number;
    endRound: number;
    mapURL?: string;
    playerLeft: MatchPlayer;
    playerRight: MatchPlayer;
}

export interface MatchDocument extends Match {
    _id?: string;
    timeStamp: Date;
    seasonId: number;
}

export interface CachedMatches {
    lastUpdated: Date;
    totalMatches: number;
    matches: Match[];
    seasonID: number;
}
