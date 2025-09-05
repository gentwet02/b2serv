import { Env, Hono, Schema } from 'hono';
import matchesHistory from './routes';

interface Router {
    [path: string]: Hono<Env, Schema, string>;
}

const router: Router = {
    '/matches-history': matchesHistory,
};

export default router;
