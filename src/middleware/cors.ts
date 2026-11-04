import { cors } from 'hono/cors';
import { env } from '@/config/environment';

const origins = env.CLIENT_URL
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const CORS = cors({
    origin: origins,
    credentials: true,
});

export default CORS;
