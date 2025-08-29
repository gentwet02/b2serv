import mongoose from 'mongoose';
import { env } from '@/config/environment';
import { logger } from '@/utils/logger';

export default async function connectDB() {
    try {
        await mongoose.connect(env.MONGODB_URI, {
            autoIndex: env.NODE_ENV === 'production' ? false : true,
        });
        logger.debug('Database successfully connected');
    } catch (error) {
        logger.error(`Database Connectivity Error: ${error}`);
    }
}
