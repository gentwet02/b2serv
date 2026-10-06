// import { fetchSeasons } from '@/services/ninjakiwi';
// import { Season } from '@/types/season';
// import { logger } from '@/utils/logger';
// import { Hono } from 'hono';
// import { contextStorage, getContext } from 'hono/context-storage';

// interface Env {
//     Variables: { seasons: Season[]; liveSeason: Season };
// }

// export const root = new Hono<Env>();

// root.use(contextStorage());

// root.use('/*', async (c, next) => {
//     try {
//         const seasons = await fetchSeasons();
//         const liveSeason = seasons.filter((season) => season.live)[0] || seasons[0];

//         c.set('seasons', seasons);
//         c.set('liveSeason', liveSeason);

//         await next();
//     } catch (error) {
//         logger.error(`Failed to fetch seasons: ${error}`);
//         await next();
//     }
// });

// export function getSeasons() {
//     return getContext<Env>().var.seasons;
// }

// export function getLiveSeason() {
//     return getContext<Env>().var.liveSeason;
// }
