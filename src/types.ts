export type NkApi = `https://data.ninjakiwi.com/battles2/${string}`;

export interface Model {
    /** The internal name of the model */
    name: string;
    /** All the different key:value of the model */
    parameters: { ['string']: string };
}

export interface LeadrboardResponse {
    error: string;
    success: boolean;
    body: LeaderboardPlayer[];
    model: Model;
    next: NkApi | null;
    prev: NkApi | null;
    maxPages: number;
}

export interface LeaderboardPlayer {
    /** The display name for this user */
    displayName: string;
    /** The HoM score */
    score: number;
    /** When true, the player is currenty in the HoM. This might be false if the user has been demoted from HoM by finishing in the demotion zone of an arena league */
    currentlyInHoM: boolean;
    /** URL to the players public profile */
    profile: string;
}

export interface MatchPlayer {
    displayName: string;
    hero: string;
    heroPortrait: string;
    towerone: string;
    towertwo: string;
    towerthree: string;
    currentUser: boolean;
    result: string;
    profileURL: string;
}

export interface Match {
    id: string;
    gametype: string;
    map: string;
    duration: number;
    endRound: number;
    mapURL: string;
    playerLeft: MatchPlayer;
    playerRight: MatchPlayer;
}
