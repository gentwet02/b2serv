import { cors } from 'hono/cors';

const origins = (process.env.CLIENT_URL ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const CORS = cors({
    origin: origins,
    credentials: true,
});

export default CORS;
