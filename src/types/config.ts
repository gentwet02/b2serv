export interface Environment {
    NODE_ENV: 'development' | 'production' | 'test';
    PORT: number;
    MONGODB_URI: string;
    NK_BASE_URL: string;
    NK_FETCH_INTERVAL: number;
    NK_FETCH_RETRIES: number;
    CLIENT_URL: string;
    CURRENT_SEASON: number;
}
