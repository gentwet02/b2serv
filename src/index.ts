import { Hono } from 'hono';
import CORS from '@/middleware/cors';
import router from '@/router';
import connectDB from '@/services/database';
import { startLeaderboardScheduler } from '@/services/leaderboard';
import { startMatchesScheduler } from '@/routes/matchesHistory';
import { listProfileAssetUrls } from '@/services/profileStore';
import { startProfileSweep } from '@/services/profileSweep';
import { startSeasonsScheduler } from '@/services/seasons';
import { env } from '@/config/environment';
import { logger } from '@/utils/logger';
import { learnAssetUrl } from '@/utils/assets';

const app = new Hono();

app.use('*', CORS);

for (const [path, handler] of Object.entries(router)) {
    app.route(path, handler);
}

await connectDB();
void listProfileAssetUrls()
    .then((urls) => urls.forEach(learnAssetUrl))
    .catch((e) => logger.error(`Learning stored asset links failed: ${e}`));
await startSeasonsScheduler();

(async () => {
    await startLeaderboardScheduler();
    await startMatchesScheduler();
    startProfileSweep();
})().catch((e) => logger.error(`Background startup failed: ${e}`));

logger.debug('Server ready!');

export default {
    port: env.PORT,
    fetch: app.fetch,
    // Bun's default is 10 s: a slower "all seasons" read was cut, then retried by the client,
    // and the retry started the same heavy work again. Heavy reads give up well before this.
    idleTimeout: 60,
};
