import { HEAVY_QUERY_MAX_MS } from '@/config/limits';
import { clanIdOfPlayer, clanMemberCodes, loadClanMembers } from '@/services/clanMembers';
import { clanLabels } from '@/services/clanStore';
import { loadCodeBook, playerCodeOf, playerOf } from '@/services/codeBook';
import { bump, gamesOf, resultFor, type Wld } from '@/services/h2h';
import { collection } from '@/services/matchStore';
import type { NkGuildId, NkUserId } from '@/types/ninjakiwi';
import { cached } from '@/utils/cache';
import { heavy } from '@/utils/heavy';
import { aliasOf, tagOf } from '@/utils/players';

/**
 * Everyone a player or a clan met: the players, and the clans those players are in today.
 * What the stats page offers as the other side once this one is picked.
 */

/** Players listed, most games first. */
const MAX_OPPONENTS = 500;

export type MetSide = { player: NkUserId } | { clan: NkGuildId };

/**
 * The players and the clans a side met in these seasons, most games first, with the side's
 * record against each. A clan's own members aren't its opponents; a player's clan mates are.
 */
export function opponentsOfSide(side: MetSide, seasonIds: number[]) {
    const key = 'player' in side ? `p:${side.player}` : `c:${side.clan}`;
    return cached(`met:${key}:${seasonIds.join(',')}`, () =>
        heavy(async () => {
            await Promise.all([loadCodeBook(), loadClanMembers()]);
            const me = 'player' in side ? playerCodeOf(side.player) : undefined;
            const codes =
                'clan' in side ? clanMemberCodes(side.clan) : me === undefined ? [] : [me];
            if (codes.length === 0) return { opponents: [], clans: [] };
            const mine = new Set(codes);
            const own = 'clan' in side ? side.clan : undefined;

            const records = new Map<number, Wld>();
            const any = codes.length === 1 ? codes[0]! : { $in: codes };
            for (const seasonId of seasonIds) {
                const cursor = collection(seasonId).find(
                    { $or: [{ a: any }, { b: any }] },
                    {
                        projection: { a: 1, b: 1, d: 1 },
                        maxTimeMS: HEAVY_QUERY_MAX_MS,
                        batchSize: 2000,
                    },
                );
                for await (const doc of cursor) {
                    for (const left of [true, false]) {
                        const them = left ? doc.b : doc.a;
                        if (!mine.has(left ? doc.a : doc.b) || mine.has(them)) continue;
                        const i = resultFor(doc, left);
                        if (i !== undefined) bump(records, them, i);
                    }
                }
            }

            const byClan = new Map<string, { record: Wld; met: number }>();
            for (const [code, record] of records) {
                const clanId = clanIdOfPlayer(code);
                if (!clanId || clanId === own) continue;
                const entry = byClan.get(clanId) ?? { record: [0, 0, 0] as Wld, met: 0 };
                record.forEach((n, i) => (entry.record[i]! += n));
                entry.met++;
                byClan.set(clanId, entry);
            }
            const labels = await clanLabels([...byClan.keys()]);

            return {
                opponents: [...records]
                    .sort((a, b) => gamesOf(b[1]) - gamesOf(a[1]))
                    .slice(0, MAX_OPPONENTS)
                    .flatMap(([code, record]) => {
                        const player = playerOf(code);
                        if (!player?.u) return [];
                        const others = player.o ?? [];
                        return {
                            userId: player.u,
                            name: player.n ?? null,
                            alias: aliasOf(player.u) ?? null,
                            tag: tagOf(player.u) ?? null,
                            ...(others.length > 0 && { oldNames: others }),
                            record,
                        };
                    }),
                clans: [...byClan]
                    .flatMap(([id, { record, met }]) => {
                        const label = labels.get(id);
                        // its players the side met
                        return label ? { id, name: label.name, met, record } : [];
                    })
                    .sort((a, b) => gamesOf(b.record) - gamesOf(a.record)),
            };
        }),
    );
}
