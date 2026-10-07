import mongoose, { Schema, type Model } from 'mongoose';
import { COLLECTIONS } from '@/config/constants';
import type { LeaderboardPlayer } from '@/types/leaderboard';
import { logger } from '@/utils/logger';

/** One document per season, in the `leaderboards` collection. */
export interface StoredLeaderboard {
    seasonId: number;
    players: LeaderboardPlayer[];
    updatedAt: Date;
    /** true once the season is over: its ranking can't change anymore, never refetch it. */
    final: boolean;
}

const playerSchema = new Schema<LeaderboardPlayer>(
    {
        displayName: { type: String, required: true },
        score: { type: Number, required: true },
        currentlyInHoM: { type: Boolean, required: true },
        profile: { type: String, required: true },
    },
    { _id: false },
);

const leaderboardSchema = new Schema<StoredLeaderboard>(
    {
        seasonId: { type: Number, required: true, unique: true },
        players: { type: [playerSchema], default: [] },
        updatedAt: { type: Date, required: true },
        final: { type: Boolean, default: false },
    },
    { collection: COLLECTIONS.LEADERBOARDS, versionKey: false },
);

// reuse the model on hot reload
const LeaderboardModel =
    (mongoose.models.Leaderboard as Model<StoredLeaderboard> | undefined) ??
    mongoose.model<StoredLeaderboard>('Leaderboard', leaderboardSchema);

export async function loadStoredLeaderboard(seasonId: number): Promise<StoredLeaderboard | null> {
    try {
        return await LeaderboardModel.findOne({ seasonId }, { _id: 0 }).lean<StoredLeaderboard>();
    } catch (error) {
        logger.error(`Loading stored leaderboard of season ${seasonId} failed: ${error}`);
        return null;
    }
}

export async function storeLeaderboard(entry: StoredLeaderboard): Promise<void> {
    try {
        await LeaderboardModel.updateOne(
            { seasonId: entry.seasonId },
            { $set: entry },
            { upsert: true },
        );
    } catch (error) {
        logger.error(`Storing leaderboard of season ${entry.seasonId} failed: ${error}`);
    }
}

/** Season ids already stored as final, to skip them when warming up. */
export async function listFinalSeasonIds(): Promise<Set<number>> {
    try {
        const docs = await LeaderboardModel.find({ final: true }, { seasonId: 1, _id: 0 }).lean();
        return new Set(docs.map((d) => d.seasonId));
    } catch (error) {
        logger.error(`Listing stored leaderboards failed: ${error}`);
        return new Set();
    }
}

/** Every stored season (for the rank history of players). */
export async function loadAllStoredLeaderboards(): Promise<StoredLeaderboard[]> {
    try {
        return await LeaderboardModel.find({}, { _id: 0 }).lean<StoredLeaderboard[]>();
    } catch (error) {
        logger.error(`Loading stored leaderboards failed: ${error}`);
        return [];
    }
}
