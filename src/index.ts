import { Hono } from 'hono';
import CORS from '@/middleware/cors';
import connectDB from '@/services/database';
import router from '@/router';
import { startSeasonsScheduler } from '@/services/seasons';
import { startLeaderboardScheduler } from '@/services/leaderboard';
import { startMatchesScheduler } from '@/routes/matchesHistory';
import { logger } from '@/utils/logger';

const app = new Hono();

app.use('*', CORS);

for (const [path, handler] of Object.entries(router)) {
    app.route(path, handler);
}

await connectDB();
await startSeasonsScheduler();

(async () => {
    await startLeaderboardScheduler();
    await startMatchesScheduler();
})().catch((e) => logger.error(`Background startup failed: ${e}`));

logger.debug('Server ready!');

export default app;
