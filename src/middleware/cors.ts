import { cors } from 'hono/cors';

const CORS = cors({
    origin: 'http://localhost:5173',
    credentials: true,
});

export default CORS;
