import { Hono } from 'hono';
import { requestAvatars } from '@/services/playerData';
import { logger } from '@/utils/logger';

/**
 * GET /avatars?ids=a,b,c   (at most MAX_IDS ids)
 * { avatars: { id: url }, pending: [id] }
 *
 * `avatars` are the ones we already have (memory or MongoDB).
 * `pending` are players whose profile is being fetched from Ninja Kiwi right now
 * (low priority, through the rate limiter): ask again in a few seconds.
 * A player in neither list has no avatar we can get for now.
 */
export const avatars = new Hono();

const USER_ID = /^[a-z0-9]{8,64}$/i;
const MAX_IDS = 100;

avatars.get('/', async (c) => {
    const ids = [
        ...new Set(
            (c.req.query('ids') ?? '')
                .split(',')
                .map((id) =>
                    id
                        .trim()
                        .replace(
                            'https://static-api.nkstatic.com/appdocs/4/assets/opendata/d7c9cd31c606931c820c46e595a1d54e_look_of_doom_avatar.png',
                            'https://static-api.nkstatic.com/appdocs/4/assets/opendata/6ed5a24051802fe844e2752b8e2921c8_look_of_doom_avatar_animated.png',
                        ),
                )
                .filter((id) => USER_ID.test(id)),
        ),
    ].slice(0, MAX_IDS);

    if (ids.length === 0) {
        const message = 'Give player ids as ?ids=a,b,c';
        return c.json({ message, error: message }, 400);
    }

    try {
        const result = await requestAvatars(ids);
        // the answer changes as background fetches finish: never let a cache keep it
        c.header('Cache-Control', 'no-store');
        return c.json(result);
    } catch (error) {
        logger.error(`Avatars of ${ids.length} player(s) failed: ${error}`);
        const message = 'Could not load the avatars.';
        return c.json({ message, error: message }, 500);
    }
});
