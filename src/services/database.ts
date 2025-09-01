import mongoose from 'mongoose';
import { env } from '@/config/environment';
import { Match } from '@/models/Match';
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

export const createMatch = async (match: MatchDocument) => {
    try {
        logger.debug(`Creating match with ID: ${match.id}`);
        const newMatch = await Match.create(match);
        logger.debug(`Successfully added match: ${match.id} to the database`);
        return newMatch;
    } catch (error) {
        logger.error(`Error creating match ${match.id}: ${error}`);
        throw error;
    }
};

export const getAllMatches = async () => {
    try {
        logger.debug('Fetching all matches from database...');
        const matches = await Match.find().sort({ timeStamp: -1 });
        logger.debug(`Successfully fetched ${matches.length} matches`);
        return matches;
    } catch (error) {
        logger.error(`Error fetching all matches: ${error}`);
        throw error;
    }
};

export const getMatchById = async (id: string) => {
    try {
        logger.debug(`Fetching match with ID: ${id}`);
        const match = await Match.findOne({ id });
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

export const getMatchesBySeason = async (seasonId: number) => {
    try {
        logger.debug(`Fetching matches for season: ${seasonId}`);
        const matches = await Match.find({ seasonId }).sort({ timeStamp: -1 });
        logger.debug(`Successfully fetched ${matches.length} matches for season ${seasonId}`);
        return matches;
    } catch (error) {
        logger.error(`Error fetching matches for season ${seasonId}: ${error}`);
        throw error;
    }
};

export const updateMatch = async (id: string, updateData: any) => {
    try {
        logger.debug(`Updating match with ID: ${id}`);
        const updatedMatch = await Match.findOneAndUpdate({ id }, updateData, {
            new: true,
            runValidators: true,
        });
        if (updatedMatch) {
            logger.debug(`Successfully updated match: ${id}`);
        } else {
            logger.debug(`No match found to update with ID: ${id}`);
        }
        return updatedMatch;
    } catch (error) {
        logger.error(`Error updating match ${id}: ${error}`);
        throw error;
    }
};

export const deleteMatch = async (id: string) => {
    try {
        logger.debug(`Deleting match with ID: ${id}`);
        const deletedMatch = await Match.findOneAndDelete({ id });
        if (deletedMatch) {
            logger.debug(`Successfully deleted match: ${id}`);
        } else {
            logger.debug(`No match found to delete with ID: ${id}`);
        }
        return deletedMatch;
    } catch (error) {
        logger.error(`Error deleting match ${id}: ${error}`);
        throw error;
    }
};
