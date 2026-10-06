import { Env, Hono, Schema } from 'hono';
import { info, matchesHistory } from './routes';
import { leaderboard } from './routes/leaderboard';
import { players } from './routes/players';
import { matches } from './routes/matches';
import { recentHistory } from './routes/recentHistory';
import { users } from './routes/users';

interface Router {
    [path: string]: Hono<Env, Schema, string>;
}

const router: Router = {
    '/info': info,
    '/leaderboard': leaderboard,
    '/matches': matches,
    '/matches-history': matchesHistory,
    '/players': players,
    '/recent-history': recentHistory,
    '/users': users,
};

export default router;
