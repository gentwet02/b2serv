export interface Environment {
    NODE_ENV: 'development' | 'production' | 'test';
    PORT: number;
    MONGODB_URI: string;
    NK_FETCH_INTERVAL: number;
    NK_FETCH_RETRIES: number;
    NK_REQUESTS_PER_SECOND: number;
    /** NK's own cap is ~100 a minute per IP (Cloudflare): stay under it, everything included */
    NK_REQUESTS_PER_MINUTE: number;
    CLIENT_URL: string;
    /** unlocks admin endpoints (x-admin-token header); unset = they are off */
    ADMIN_TOKEN: string;
}
