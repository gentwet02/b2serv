import { cors } from 'hono/cors';

export const CORS = cors({
    origin: 'http://localhost:5173',
    credentials: true,
});
