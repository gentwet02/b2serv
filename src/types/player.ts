export interface PlayerDocument {
    _id?: string;
    userId: string;
    displayName: string;
    profile: string;
    lastSeen: Date;
    seasonData: {
        seasonId: number;
        score: number;
        currentlyInHoM: boolean;
        lastUpdated: Date;
    }[];
}
