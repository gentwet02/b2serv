import mongoose from 'mongoose';
import { env } from '@/config/environment';
import { loadCodeBook } from '@/services/codeBook';
import { getAllStoredMatches, getMatchesOfPlayer, getStoredMatch } from '@/services/matchStore';
import { logger } from '@/utils/logger';

export default async function connectDB() {
    logger.debug('Attempting to connect to database...');
    try {
        await mongoose.connect(env.MONGODB_URI, {
            autoIndex: env.NODE_ENV !== 'production',
            serverSelectionTimeoutMS: 5000,
        });
        logger.debug(`Database connected (${mongoose.connection.name})`);
        await loadCodeBook();
    } catch (error) {
        logger.error(`Database Connectivity Error: ${error}`);
        throw error;
    }
}

export const isDbConnected = () => mongoose.connection.readyState === 1;

export async function getAllMatches(seasonId: number) {
    logger.debug(`Fetching all matches of season ${seasonId}...`);
    const matches = await getAllStoredMatches(seasonId);
    logger.debug(`Fetched ${matches.length} matches`);
    return matches;
}

export async function getMatchById(id: string, seasonId: number) {
    return getStoredMatch(id, seasonId);
}

export async function getMatchesByUserId(userId: string, seasonId: number) {
    logger.debug(`Fetching matches of user ${userId} for season ${seasonId}`);
    const matches = await getMatchesOfPlayer(userId, seasonId);
    logger.debug(`Found ${matches.length} matches for user ${userId}`);
    return matches;
}
