import { Environment } from '../types/config';

export const env: Environment = {
    NODE_ENV: (process.env.NODE_ENV as Environment['NODE_ENV']) || 'development',
    PORT: parseInt(process.env.PORT || '3000'),
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/btd',
    NK_FETCH_INTERVAL: parseInt(process.env.NK_FETCH_INTERVAL || '300000'), // 5 minutes
    NK_FETCH_RETRIES: parseInt(process.env.NK_FETCH_RETRIES || '5'),
    CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',
};
