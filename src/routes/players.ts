import { Hono } from 'hono';
import { playerNames } from '@/data/playerNames';

export const players = new Hono();

let cachedPlayers: { [key: string]: string } = playerNames;

players.get('/:id?', async (c) => {
    const id = c.req.param('id');

    if (!id) {
        return c.json(cachedPlayers);
    }

    if (!cachedPlayers[id]) {
        return c.json({
            error: {
                message: 'No data with that user id',
            },
        });
    }

    return c.json({
        id: id,
        player: cachedPlayers[id],
    });
});
