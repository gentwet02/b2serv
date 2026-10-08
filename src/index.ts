import { Hono } from 'hono';
import CORS from '@/middleware/cors';
import router from '@/router';
import connectDB from '@/services/database';
import { startLeaderboardScheduler } from '@/services/leaderboard';
import { startMatchesScheduler } from '@/routes/matchesHistory';
import { listStoredAssetUrls } from '@/services/profileCache';
import { startSeasonsScheduler } from '@/services/seasons';
import { logger } from '@/utils/logger';
import { learnAssetUrl } from '@/utils/assets';

const app = new Hono();

app.use('*', CORS);

for (const [path, handler] of Object.entries(router)) {
    app.route(path, handler);
}

await connectDB();
void listStoredAssetUrls().then((urls) => urls.forEach(learnAssetUrl));
await startSeasonsScheduler();

(async () => {
    await startLeaderboardScheduler();
    await startMatchesScheduler();
})().catch((e) => logger.error(`Background startup failed: ${e}`));

logger.debug('Server ready!');

export default app;
