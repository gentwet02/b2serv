import { Hono } from 'hono';
import { requestAvatars } from '@/services/playerData';
import { logger } from '@/utils/logger';

/**
 * GET /avatars?ids=a,b,c   (at most MAX_IDS ids)
 * { avatars: { id: url }, pending: [id] }
 *
 * `avatars` come from the stored profiles. `pending` is always empty: no request to Ninja Kiwi
 * is made for a visitor, missing avatars arrive with the next profile sweep.
 */
export const avatars = new Hono();

const USER_ID = /^[a-z0-9]{8,64}$/i;
const MAX_IDS = 100;

avatars.get('/', async (c) => {
    const ids = [
        ...new Set(
            (c.req.query('ids') ?? '')
                .split(',')
                .map((id) => id.trim())
                .filter((id) => USER_ID.test(id)),
        ),
    ].slice(0, MAX_IDS);

    if (ids.length === 0) {
        const message = 'Give player ids as ?ids=a,b,c';
        return c.json({ message, error: message }, 400);
    }

    try {
        const result = await requestAvatars(ids);
        c.header('Cache-Control', 'public, max-age=300');
        return c.json(result);
    } catch (error) {
        logger.error(`Avatars of ${ids.length} player(s) failed: ${error}`);
        const message = 'Could not load the avatars.';
        return c.json({ message, error: message }, 500);
    }
});
