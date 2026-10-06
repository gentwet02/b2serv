import { Hono } from 'hono';

export const recentHistory = new Hono();

recentHistory.get('/', (c) => {
    return c.json({});
});
