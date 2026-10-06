import mongoose from 'mongoose';
import { env } from '@/config/environment';
import { matchSchema } from '@/models/Match';
import { logger } from '@/utils/logger';
import type { MatchDocument } from '@/types/match';

export default async function connectDB() {
    try {
        logger.debug('Attempting to connect to database...');
        await mongoose.connect(env.MONGODB_URI, {
            autoIndex: env.NODE_ENV === 'production' ? false : true,
        });
        logger.debug('Database successfully connected');
    } catch (error) {
        logger.error(`Database Connectivity Error: ${error}`);
    }
}

export const createMatch = async (match: MatchDocument, seasonId: number) => {
    try {
        logger.debug(`Creating match with ID: ${match.i}`);
        const newMatch = await mongoose
            .model('Match', matchSchema, `season${seasonId}`)
            .create(match);
        logger.debug(`Successfully added match: ${match.i} to the database`);
        return newMatch;
    } catch (error) {
        logger.error(`Error creating match ${match.i}: ${error}`);
        throw error;
    }
};

export const getAllMatches = async (seasonId: number) => {
    try {
        logger.debug('Fetching all matches from database...');
        const matches = await mongoose
            .model('Match', matchSchema, `season${seasonId}`)
            .find()
            .sort({ timeStamp: -1 });
        logger.debug(`Successfully fetched ${matches.length} matches`);
        return matches;
    } catch (error) {
        logger.error(`Error fetching all matches: ${error}`);
        throw error;
    }
};

export const getMatchById = async (id: string, seasonId: number) => {
    try {
        logger.debug(`Fetching match with ID: ${id}`);
        const match = await mongoose
            .model('Match', matchSchema, `season${seasonId}`)
            .findOne({ i: id });
        if (match) {
            logger.debug(`Successfully found match: ${id}`);
        } else {
            logger.debug(`No match found with ID: ${id}`);
        }
        return match;
    } catch (error) {
        logger.error(`Error fetching match ${id}: ${error}`);
        throw error;
    }
};

export const getMatchesByUserId = async (id: string, seasonId: number) => {
    try {
        logger.debug(`Fetching matches with user ID: ${id}`);
        const matches = await mongoose
            .model('Match', matchSchema, `season${seasonId}`)
            .find({ $or: [{ 'pl.i': id }, { 'pr.i': id }] });
        if (matches) {
            logger.debug(`Successfully found matches for user ID: ${id}`);
        } else {
            logger.debug(`No match found with user ID: ${id}`);
        }
        return matches;
    } catch (error) {
        logger.error(`Error fetching match ${id}: ${error}`);
        throw error;
    }
};
