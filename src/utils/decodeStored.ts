// import { heroMap, mapMap, opposingResult, resultMap, towerMap } from '@/data/codes';

// /**
//  * Stored matches pack their data in numbers (see utils/encode.ts).
//  * Arithmetic instead of string slicing: the leading zeros parseInt dropped don't matter.
//  */

// export const unpackResult = (d: number) => ({
//     result: Math.floor(d / 1e8),
//     map: Math.floor(d / 1e6) % 100,
//     endRound: Math.floor(d / 1e4) % 100,
//     duration: d % 1e4,
// });

// export const unpackTowers = (t: number) => ({
//     hero: Math.floor(t / 1e6),
//     towers: [Math.floor(t / 1e4) % 100, Math.floor(t / 1e2) % 100, t % 100],
// });

// const name = (list: readonly string[], index: number) => list[index] ?? 'Unknown';

// export function decodeStoredSide(t: number) {
//     const { hero, towers } = unpackTowers(t);
//     return {
//         hero: name(heroMap, hero),
//         towerone: name(towerMap, towers[0]),
//         towertwo: name(towerMap, towers[1]),
//         towerthree: name(towerMap, towers[2]),
//     };
// }

// export function decodeStoredResult(d: number) {
//     const { result, map, endRound, duration } = unpackResult(d);
//     const left = name(resultMap, result);
//     return {
//         map: name(mapMap, map),
//         endRound,
//         duration,
//         leftResult: left,
//         rightResult: opposingResult[left] ?? left,
//     };
// }

// // --- the same unpacking as MongoDB aggregation expressions ---------------------------

// const digits = (field: string, divisor: number, modulo?: number) => {
//     const shifted = divisor === 1 ? field : { $floor: { $divide: [field, divisor] } };
//     return modulo ? { $mod: [shifted, modulo] } : shifted;
// };

// export const mongoResult = {
//     map: digits('$d', 1e6, 100),
//     endRound: digits('$d', 1e4, 100),
//     duration: { $mod: ['$d', 1e4] },
// };

// export const mongoSide = (side: 'pl' | 'pr') => ({
//     hero: digits(`$${side}.t`, 1e6),
//     towers: [
//         digits(`$${side}.t`, 1e4, 100),
//         digits(`$${side}.t`, 1e2, 100),
//         { $mod: [`$${side}.t`, 100] },
//     ],
// });
