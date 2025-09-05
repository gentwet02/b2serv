import { Hono } from 'hono';
import CORS from '@/middleware/cors';
import connectDB from '@/services/database';
import router from '@/router';

const app = new Hono();

app.use('*', CORS);

connectDB();

for (const [path, handler] of Object.entries(router)) {
    app.route(path, handler);
}

export default app;
