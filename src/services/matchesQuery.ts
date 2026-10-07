// import mongoose, { type PipelineStage } from 'mongoose';
// import { heroCodesFor, mapMap, towerMap } from '@/data/codes';
// import { findPlayerIds, getAssetUrl, getPlayerNames } from '@/services/matchMeta';
// import type { Match, MatchDocument } from '@/types/match';
// import { decodeStoredResult, decodeStoredSide, mongoResult, mongoSide } from '@/utils/decodeStored';
// import { logger } from '@/utils/logger';

// export const MATCH_SORTS = ['newest', 'oldest', 'longest', 'shortest', 'rounds'] as const;
// export type MatchSort = (typeof MATCH_SORTS)[number];

// export interface MatchesFilter {
//     seasonId: number;
//     offset: number;
//     limit: number;
//     sort: MatchSort;
//     /** part of a player name */
//     player?: string;
//     /** base hero, skins included ("Quincy") */
//     hero?: string;
//     tower?: string;
//     map?: string;
// }

// /** A stored match decoded back to Ninja Kiwi's shape, plus when we first saw it. */
// export interface StoredMatch extends Match {
//     seenAt: string;
// }

// const collection = (seasonId: number) =>
//     mongoose.connection.collection<MatchDocument>(`season${seasonId}`);

// /**
//  * Player, hero and tower filters apply to the SAME player in a match:
//  * "Lazer + Quincy + Druid" means Lazer played Quincy with Druid, on either side.
//  */
// function sideCondition(
//     side: 'pl' | 'pr',
//     playerIds: string[] | null,
//     heroCodes: number[] | null,
//     tower: number | null,
// ) {
//     const expr = mongoSide(side);
//     const all: object[] = [];
//     if (playerIds) all.push({ $in: [`$${side}.i`, playerIds] });
//     if (heroCodes) all.push({ $in: [expr.hero, heroCodes] });
//     if (tower !== null) all.push({ $in: [tower, expr.towers] });
//     return all.length === 0 ? null : { $and: all };
// }

// const SORT_STAGES: Record<MatchSort, Record<string, 1 | -1>> = {
//     newest: { t: -1, _id: -1 },
//     oldest: { t: 1, _id: 1 },
//     longest: { _duration: -1, t: -1 },
//     shortest: { _duration: 1, t: -1 },
//     rounds: { _endRound: -1, t: -1 },
// };

// export async function queryStoredMatches(filter: MatchesFilter) {
//     const { seasonId, offset, limit, sort } = filter;

//     let playerIds: string[] | null = null;
//     if (filter.player) {
//         playerIds = await findPlayerIds(filter.player);
//         if (playerIds.length === 0) return { total: 0, items: [] as StoredMatch[] };
//     }
//     const heroCodes = filter.hero ? heroCodesFor(filter.hero) : null;
//     const tower = filter.tower ? towerMap.indexOf(filter.tower) : null;
//     const map = filter.map ? mapMap.indexOf(filter.map) : null;

//     const pipeline: PipelineStage[] = [];

//     // indexed pre-filter (pl.i / pr.i) before the computed conditions
//     if (playerIds) {
//         pipeline.push({
//             $match: { $or: [{ 'pl.i': { $in: playerIds } }, { 'pr.i': { $in: playerIds } }] },
//         });
//     }

//     const conditions: object[] = [];
//     if (map !== null && map >= 0) conditions.push({ $eq: [mongoResult.map, map] });
//     const left = sideCondition('pl', playerIds, heroCodes, tower);
//     const right = sideCondition('pr', playerIds, heroCodes, tower);
//     if (left && right) conditions.push({ $or: [left, right] });
//     if (conditions.length > 0) pipeline.push({ $match: { $expr: { $and: conditions } } });

//     if (sort === 'longest' || sort === 'shortest') {
//         pipeline.push({ $addFields: { _duration: mongoResult.duration } });
//     } else if (sort === 'rounds') {
//         pipeline.push({ $addFields: { _endRound: mongoResult.endRound } });
//     }

//     pipeline.push(
//         { $sort: SORT_STAGES[sort] },
//         {
//             $facet: {
//                 items: [
//                     { $skip: offset },
//                     { $limit: limit },
//                     { $project: { _duration: 0, _endRound: 0 } },
//                 ],
//                 total: [{ $count: 'n' }],
//             },
//         },
//     );

//     const started = Date.now();
//     const [result] = await collection(seasonId)
//         .aggregate<{
//             items: MatchDocument[];
//             total: { n: number }[];
//         }>(pipeline, { allowDiskUse: true })
//         .toArray();
//     const ms = Date.now() - started;
//     if (ms > 500) logger.warn(`Slow match query (${ms}ms): ${JSON.stringify(filter)}`);

//     const docs = result?.items ?? [];
//     return { total: result?.total[0]?.n ?? 0, items: await decodeDocs(docs) };
// }

// async function decodeDocs(docs: MatchDocument[]): Promise<StoredMatch[]> {
//     const names = await getPlayerNames(docs.flatMap((d) => [d.pl.i, d.pr.i]));
//     const profileURL = (id: string) => `https://data.ninjakiwi.com/battles2/users/${id}`;

//     return Promise.all(
//         docs.map(async (doc) => {
//             const result = decodeStoredResult(doc.d);
//             const side = async (stored: MatchDocument['pl'], outcome: string) => {
//                 const decoded = decodeStoredSide(stored.t);
//                 return {
//                     displayName: names.get(stored.i) ?? 'Unknown player',
//                     ...decoded,
//                     heroPortrait: await getAssetUrl('hero', decoded.hero),
//                     result: outcome,
//                     profileURL: profileURL(stored.i),
//                 };
//             };
//             return {
//                 id: doc.i,
//                 gametype: 'Ranked',
//                 map: result.map,
//                 mapURL: await getAssetUrl('map', result.map),
//                 endRound: result.endRound,
//                 duration: result.duration,
//                 playerLeft: await side(doc.pl, result.leftResult),
//                 playerRight: await side(doc.pr, result.rightResult),
//                 seenAt: new Date(doc.t).toISOString(),
//             };
//         }),
//     );
// }

// export async function countStoredMatches(seasonId: number) {
//     try {
//         return await collection(seasonId).estimatedDocumentCount();
//     } catch {
//         return 0;
//     }
// }
