import { Hono } from 'hono';
import { playerNames } from '@/config/playerNames';
import { aliasOf, tagOf } from '@/utils/players';

export const players = new Hono();

let cachedPlayers: { [key: string]: string } = playerNames;

players.get('/:id?', async (c) => {
    const id = c.req.param('id');

    if (!id) {
        return c.json(cachedPlayers);
    }

    const alias = aliasOf(id);
    if (!alias) {
        return c.json({
            error: {
                message: 'No data with that user id',
            },
        });
    }

    const tag = tagOf(id);
    return c.json({
        id: id,
        player: alias,
        ...(tag && { tag }),
    });
});
