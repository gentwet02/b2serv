import { Hono } from 'hono';
import { CORS } from './middleware/cors';
import { matchesHistory } from './routes/matchesHistory';

const app = new Hono();

app.use('*', CORS);

app.route('/matches-history', matchesHistory);

export default app;
