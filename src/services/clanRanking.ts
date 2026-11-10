import { CLAN_RANKING_TTL_MS } from '@/config/cache';
import { HEAVY_QUERY_MAX_MS } from '@/config/limits';
import { clanIdOfPlayer, loadClanMembers } from '@/services/clanMembers';
import { listClans } from '@/services/clanStore';
import { CODE_BITS, loadCodeBook, nameOf } from '@/services/codeBook';
import { byScore, RESULT_INDEX, type Wld } from '@/services/h2h';
import { collection, opposingResult } from '@/services/matchStore';
import { getLiveSeason } from '@/services/seasons';
import type { ClanSummary } from '@/types/clan';
import { createCache } from '@/utils/cache';
import { heavy } from '@/utils/heavy';

/**
 * The clans ranked by how their known members do in the live season: win rate, shrunk toward
 * the average when a clan played little (h2h.byScore), so both the games played and the win
 * rate count. Clans without a game this season come after, the most known players first.
 * One aggregation over the season's matches (every player's record), cached.
 */

const cache = createCache({ ttlMs: CLAN_RANKING_TTL_MS, max: 4 });

/** Every player's record in a season, by player code. */
async function playerRecords(seasonId: number) {
    const records = new Map<number, Wld>();
    for (const side of [
        { player: '$a', left: true },
        { player: '$b', left: false },
    ]) {
        const rows = await collection(seasonId)
            .aggregate<{ _id: { p: number; r: number }; n: number }>(
                [
                    {
                        $group: {
                            _id: { p: side.player, r: { $mod: ['$d', 2 ** CODE_BITS.result] } },
                            n: { $sum: 1 },
                        },
                    },
                ],
                { allowDiskUse: true, maxTimeMS: HEAVY_QUERY_MAX_MS },
            )
            .toArray();
        for (const { _id, n } of rows) {
            const leftResult = nameOf('result', _id.r);
            const result = side.left ? leftResult : (opposingResult[leftResult] ?? leftResult);
            const i = RESULT_INDEX[result];
            if (i === undefined) continue; // cancelled / lobby disconnect: not played
            const record = records.get(_id.p) ?? [0, 0, 0];
            record[i] += n;
            records.set(_id.p, record);
        }
    }
    return records;
}

export interface RankedClan extends ClanSummary {
    /** its known members' games in the live season, added up */
    record: Wld;
}

/** Every clan we can name, best first. Don't call from inside a heavy read: it is one. */
export function rankClans(): Promise<RankedClan[]> {
    const seasonId = getLiveSeason()?.seasonId;
    return cache(`clan-ranking:${seasonId ?? 'none'}`, async () => {
        await Promise.all([loadCodeBook(), loadClanMembers()]);
        const byClan = new Map<string, Wld>();
        const total: Wld = [0, 0, 0];
        const players = seasonId === undefined ? [] : await heavy(() => playerRecords(seasonId));
        for (const [code, record] of players) {
            const clanId = clanIdOfPlayer(code);
            if (!clanId) continue;
            const sum = byClan.get(clanId) ?? [0, 0, 0];
            record.forEach((n, i) => {
                sum[i]! += n;
                total[i]! += n;
            });
            byClan.set(clanId, sum);
        }
        // listClans: the clans with a reading, the most known players first
        const clans = new Map((await listClans()).map((c) => [c.id, c]));
        const ranked: RankedClan[] = [];
        for (const { key, record } of byScore(byClan, total)) {
            const clan = clans.get(key);
            if (!clan) continue;
            ranked.push({ ...clan, record });
            clans.delete(key);
        }
        for (const clan of clans.values()) ranked.push({ ...clan, record: [0, 0, 0] });
        return ranked;
    });
}
