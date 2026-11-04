import { Hono } from 'hono';
import { MAX_AVATAR_IDS } from '@/config/limits';
import { requestAvatars } from '@/services/playerData';
import { isNkUserId } from '@/utils/helpers';
import { logger } from '@/utils/logger';

/**
 * GET /avatars?ids=a,b,c   (at most MAX_AVATAR_IDS ids)
 * { avatars: { id: url }, pending: [id] }
 *
 * `avatars` come from the stored profiles. `pending` is always empty: no request to Ninja Kiwi
 * is made for a visitor, missing avatars arrive with the next profile sweep.
 */
export const avatars = new Hono();

avatars.get('/', async (c) => {
    const ids = [
        ...new Set(
            (c.req.query('ids') ?? '')
                .split(',')
                .map((id) => id.trim())
                .filter((id) => isNkUserId(id)),
        ),
    ].slice(0, MAX_AVATAR_IDS);

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
