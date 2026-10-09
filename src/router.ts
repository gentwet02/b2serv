import { Env, Hono, Schema } from 'hono';
import { avatars, info, leaderboard, matches, matchesHistory, players, users } from './routes';

interface Router {
    [path: string]: Hono<Env, Schema, string>;
}

const router: Router = {
    '/avatars': avatars,
    '/info': info,
    '/leaderboard': leaderboard,
    '/matches': matches,
    '/matches-history': matchesHistory,
    '/players': players,
    '/users': users,
};

export default router;
