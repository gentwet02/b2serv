import { Env, Hono, Schema } from 'hono';
import { avatars, compare, info, leaderboard, matches, matchesHistory, players, stats, users } from './routes';

interface Router {
    [path: string]: Hono<Env, Schema, string>;
}

const router: Router = {
    '/avatars': avatars,
    '/compare': compare,
    '/info': info,
    '/leaderboard': leaderboard,
    '/matches': matches,
    '/matches-history': matchesHistory,
    '/players': players,
    '/stats': stats,
    '/users': users,
};

export default router;
