import { Environment } from '../types/config';

function getEnv(): Environment {
    return {
        NODE_ENV: (process.env.NODE_ENV as Environment['NODE_ENV']) || 'development',
        PORT: parseInt(process.env.PORT || '3001'),
        MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/battles2',
        NK_BASE_URL: process.env.NK_BASE_URL || 'https://data.ninjakiwi.com/battles2',
        NK_FETCH_INTERVAL: parseInt(process.env.NK_FETCH_INTERVAL || '300000'), // 5 minutes
        NK_FETCH_RETRIES: parseInt(process.env.NK_FETCH_RETRIES || '5'),
        CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:3000',
        CURRENT_SEASON: parseInt(process.env.CURRENT_SEASON || '34'),
    };
}

export const env = getEnv();
