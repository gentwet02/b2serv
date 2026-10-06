import { Environment } from '@/types/config';

const num = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : fallback;
};

export const env: Environment = {
    NODE_ENV: (process.env.NODE_ENV as Environment['NODE_ENV']) || 'development',
    PORT: num(process.env.PORT, 3000),
    MONGODB_URI:
        (process.env.NODE_ENV === 'test' ? process.env.MONGODB_LOCAL : process.env.MONGODB_URI) ||
        'mongodb://localhost:27017/battles2',
    NK_FETCH_INTERVAL: num(process.env.NK_FETCH_INTERVAL, 300_000), // 5 minutes
    NK_FETCH_RETRIES: num(process.env.NK_FETCH_RETRIES, 5),
    NK_REQUESTS_PER_SECOND: num(process.env.NK_REQUESTS_PER_SECOND, 2),
    CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',
};
