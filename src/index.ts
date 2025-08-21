import { Hono } from 'hono';
import { matches } from './routes/matches';

const app = new Hono();

app.route('/matches', matches);

export default app;
