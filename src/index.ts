import { Hono } from 'hono';
import { CORS } from '@/middleware/cors';
import matchesHistory from '@/routes';
import connectDB from '@/services/database';

const app = new Hono();

app.use('*', CORS);

connectDB();

app.route('/matches-history', matchesHistory);

export default app;
