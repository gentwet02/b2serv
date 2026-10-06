import mongoose, { type Model } from 'mongoose';
import { env } from '@/config/environment';
import { matchSchema } from '@/models/Match';
import { logger } from '@/utils/logger';
import type { MatchDocument } from '@/types/match';

export default async function connectDB() {
    logger.debug('Attempting to connect to database...');
    try {
        await mongoose.connect(env.MONGODB_URI, {
            autoIndex: env.NODE_ENV !== 'production',
            serverSelectionTimeoutMS: 5000,
            allowPartialTrustChain: undefined,
            ALPNProtocols: undefined,
            ca: undefined,
            cert: undefined,
            checkServerIdentity: undefined,
            ciphers: undefined,
            crl: undefined,
            ecdhCurve: undefined,
            key: undefined,
            minDHSize: undefined,
            passphrase: undefined,
            pfx: undefined,
            rejectUnauthorized: undefined,
            secureContext: undefined,
            secureProtocol: undefined,
            servername: undefined,
            session: undefined,
            autoSelectFamily: undefined,
            autoSelectFamilyAttemptTimeout: undefined,
            keepAliveInitialDelay: undefined,
            family: undefined,
            hints: undefined,
            localAddress: undefined,
            localPort: undefined,
            lookup: undefined,
        });
        logger.debug(`Database connected (${mongoose.connection.name})`);
    } catch (error) {
        logger.error(`Database Connectivity Error: ${error}`);
        throw error; // no point running without a database
    }
}

export const isDbConnected = () => mongoose.connection.readyState === 1;

function getMatchModel(seasonId: number): Model<MatchDocument> {
    if (!Number.isInteger(seasonId) || seasonId < 0) {
        throw new Error(`Invalid season id: ${seasonId}`);
    }
    const name = `Match_season${seasonId}`;
    return (
        (mongoose.models[name] as Model<MatchDocument> | undefined) ??
        mongoose.model<MatchDocument>(name, matchSchema, `season${seasonId}`)
    );
}

export async function saveMatches(docs: MatchDocument[], seasonId: number) {
    const MatchModel = getMatchModel(seasonId);
    const valid: MatchDocument[] = [];
    let invalid = 0;

    for (const doc of docs) {
        const error = new MatchModel(doc).validateSync();
        if (error) {
            invalid++;
            logger.error(`Match ${doc.i} rejected: ${error.name}`);
            continue;
        }
        valid.push(doc);
    }

    if (valid.length === 0) return { inserted: 0, invalid };

    const result = await MatchModel.bulkWrite(
        valid.map((doc) => ({
            updateOne: {
                filter: { i: doc.i },
                update: { $setOnInsert: doc },
                upsert: true,
            },
        })),
        { ordered: false },
    );

    return { inserted: result.upsertedCount, invalid };
}

export async function getAllMatches(seasonId: number) {
    logger.debug(`Fetching all matches of season ${seasonId}...`);
    const matches = await getMatchModel(seasonId).find().sort({ t: -1 }).lean();
    logger.debug(`Fetched ${matches.length} matches`);
    return matches;
}

export async function getMatchById(id: string, seasonId: number) {
    return getMatchModel(seasonId).findOne({ i: id }).lean();
}

export async function getMatchesByUserId(userId: string, seasonId: number) {
    logger.debug(`Fetching matches of user ${userId} for season ${seasonId}`);
    const matches = await getMatchModel(seasonId)
        .find({ $or: [{ 'pl.i': userId }, { 'pr.i': userId }] })
        .sort({ t: -1 })
        .lean();
    logger.debug(`Found ${matches.length} matches for user ${userId}`);
    return matches;
}
