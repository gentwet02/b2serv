import { Hono } from 'hono';
import CORS from '@/middleware/cors';
import connectDB from '@/services/database';
import router from '@/router';
import { Season } from './types/season';
import { contextStorage, getContext } from 'hono/context-storage';
import { fetchSeasons, fetchLiveSeason } from './services/ninjakiwi';
import { logger } from './utils/logger';

interface Env {
    Variables: { seasons: Season[]; liveSeason: Season };
}

const app = new Hono<Env>();

app.use('*', CORS);

connectDB();

app.use(contextStorage());

app.use(async (c, next) => {
    try {
        const seasons = await fetchSeasons();
        const liveSeason = await fetchLiveSeason(seasons);

        c.set('seasons', seasons);
        c.set('liveSeason', liveSeason);

        await next();
    } catch (error) {
        logger.error(`Failed to fetch seasons: ${error}`);
        await next();
    }
});

for (const [path, handler] of Object.entries(router)) {
    app.route(path, handler);
}

export function getSeasons() {
    return getContext<Env>().var.seasons;
}

export function getLiveSeason() {
    return getContext<Env>().var.liveSeason;
}

export default app;
