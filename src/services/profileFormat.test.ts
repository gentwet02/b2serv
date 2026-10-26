import { describe, expect, test } from 'bun:test';
import { BSON } from 'mongodb';
import type { ProfileCodeKind } from '@/services/codeBook';
import {
    applyReading,
    decodeProfile,
    pack,
    packVarints,
    profileNames,
    unpack,
    streakFromReading,
    unpackVarints,
    type Codec,
} from '@/services/profileFormat';
import type { NkProfileBody, ProfileDoc } from '@/types/profile';

/** In-memory code book: hands out numbers on first sight, like codeBook.ensureCodes. */
function memoryCodec(): Codec & { ensure(body: NkProfileBody): void } {
    const byName = new Map<string, number>();
    const byCode = new Map<string, string>();
    const next = new Map<string, number>();
    return {
        ensure(body) {
            for (const [kind, names] of profileNames(body)) {
                for (const name of names) {
                    if (byName.has(`${kind}:${name}`)) continue;
                    const c = next.get(kind) ?? 0;
                    next.set(kind, c + 1);
                    byName.set(`${kind}:${name}`, c);
                    byCode.set(`${kind}:${c}`, name);
                }
            }
        },
        code(kind: ProfileCodeKind, name: string) {
            const c = byName.get(`${kind}:${name}`);
            if (c === undefined) throw new Error(`no code for ${kind}:${name}`);
            return c;
        },
        name: (kind: ProfileCodeKind, code: number) => byCode.get(`${kind}:${code}`),
    };
}

const A = 'https://static-api.nkstatic.com/appdocs/4/assets/opendata/';

function body(
    ranked: [w: number, d: number, l: number, ws: number, hws: number],
    season = 19,
): NkProfileBody {
    return {
        displayName: 'Fabim',
        is_vip: false,
        is_club_member: true,
        equippedAvatar: 'mastery_spikefactory_avatar',
        equippedAvatarURL: `${A}e00f80ce0bf9fdd43768e0d7db4ebdf6_mastery_spikefactory_avatar.png`,
        equippedBannerURL: `${A}8a43d43d67400d4e9c1b7feb76fe3309_rooftop_run_animated_banner.png`,
        equippedBorderURL: `${A}b088afff6241a07978e9baadd11826f4_border_bfb_colosseum.png`,
        equippedTitle: 'The Sharpshooter',
        casualStats: {
            wins: 22,
            draws: 0,
            losses: 20,
            win_streak: 0,
            highest_win_streak: 4,
            no_lives_lost: 8,
            first_bloons: 19,
        },
        rankedStats: {
            wins: ranked[0],
            draws: ranked[1],
            losses: ranked[2],
            win_streak: ranked[3],
            highest_win_streak: ranked[4],
            no_lives_lost: 398,
            first_bloons: 606,
        },
        badges_equipped: [
            {
                season: 18,
                name: 'Arena_MOAB',
                iconURL: `${A}270630227abcdfdf5d3965edf083f5d0_season_medal_moab.png`,
            },
        ],
        badges_all: [
            {
                season: 1,
                name: 'Arena_Master_Top75Percent',
                iconURL: `${A}aa30630227abcdfdf5d3965edf083f5d_season_medal_hom_top75.png`,
            },
            {
                season: 18,
                name: 'Arena_MOAB',
                iconURL: `${A}270630227abcdfdf5d3965edf083f5d0_season_medal_moab.png`,
            },
        ],
        chestsOpened: 81,
        currentSeason: `season_${season}`,
        currentSeason_highestArena: 'zomg',
        currentSeason_highestArenaIndex: 7,
        currentSeason_trophies: 29,
        lifetime_highestArena: 'hom',
        lifetime_highestArenaIndex: 8,
        lifetime_trophies: 487,
        arenaLeagueTier: 7,
        inGuild: true,
        guild: 'https://data.ninjakiwi.com/battles2/guild/9fb9138adcc2fdf41e168e185e22e42299011cb9cd16db31',
        accolades: [{ type: 'Top100', subtype: 'None', value: 3 }],
        _bloonStats: [
            { bloon_type: 'Red', sends: 68929, pops: 3201760 },
            { bloon_type: 'MOAB', sends: 111, pops: 7725 },
        ],
        _towers: [
            { type: 'Quincy', used: 23, unlocked: true },
            { type: 'DartMonkey', used: 76, unlocked: false },
        ],
    };
}

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

/** One reading, through the stored form every time (like the database round trip). */
function read(
    doc: ProfileDoc | null,
    codec: ReturnType<typeof memoryCodec>,
    b: NkProfileBody,
    date: Date,
    seasonId: number | null,
) {
    codec.ensure(b);
    const next = applyReading(doc, 7, { body: b, date, seasonId }, codec);
    const back = unpack(BSON.deserialize(BSON.serialize(pack(next))) as never);
    expect(back).toEqual(next);
    return back;
}

describe('varints', () => {
    test('round trip', () => {
        const values = [0, 1, 127, 128, 255, 16_383, 16_384, 3_201_760, 2 ** 40 + 5];
        expect(unpackVarints(packVarints(values))).toEqual(values);
    });
});

describe('profile round trip', () => {
    test('keeps every medal with its season', () => {
        const codec = memoryCodec();
        const b = body([767, 0, 320, 0, 23]);
        const doc = read(null, codec, b, day(0), 19);
        const out = decodeProfile(doc, 'Fabim', codec);
        expect(out.badges_all).toEqual(b.badges_all as never);
        expect(out.badges_equipped).toEqual(b.badges_equipped as never);
        // a later reading without the field (old dump) keeps the list
        const { badges_all: _, ...older } = b;
        const next = read(doc, codec, older, day(1), 19);
        expect(decodeProfile(next, 'Fabim', codec).badges_all).toEqual(b.badges_all as never);
    });

    test('documents stored before the medal list still read', () => {
        const codec = memoryCodec();
        const { badges_all: _, ...b } = body([767, 0, 320, 0, 23]);
        const doc = read(null, codec, b, day(0), 19);
        expect(doc.ga).toBeUndefined();
        expect(decodeProfile(doc, 'Fabim', codec).badges_all).toEqual([]);
    });

    test('decode gives back the NK body', () => {
        const codec = memoryCodec();
        const b = body([767, 0, 320, 0, 23]);
        const doc = read(null, codec, b, day(0), 19);
        const out = decodeProfile(doc, 'Fabim', codec);
        expect(out.equippedAvatarURL).toBe(b.equippedAvatarURL!);
        expect(out.equippedAvatar).toBe('mastery_spikefactory_avatar');
        expect(out.equippedBannerURL).toBe(b.equippedBannerURL!);
        expect(out.equippedTitle).toBe('The Sharpshooter');
        expect(out.rankedStats).toEqual(b.rankedStats as never);
        expect(out.casualStats).toEqual(b.casualStats as never);
        expect(out._towers).toEqual(b._towers as never);
        expect(out._bloonStats).toEqual(b._bloonStats as never);
        expect(out.accolades).toEqual(b.accolades as never);
        expect(out.badges_equipped).toEqual(b.badges_equipped as never);
        expect(out.guild).toBe(b.guild!);
        expect(out.is_club_member).toBe(true);
        expect(out.currentSeason).toBe('season_19');
        expect(out.currentSeason_highestArena).toBe('zomg');
        expect(out.lifetime_highestArena).toBe('hom');
        expect(out.lifetime_trophies).toBe(487);
        expect(out.chestsOpened).toBe(81);
    });

    test('stays small', () => {
        const codec = memoryCodec();
        const b = body([767, 0, 320, 0, 23]);
        let doc = read(null, codec, b, day(0), 18);
        doc = read(doc, codec, body([800, 0, 330, 2, 23]), day(40), 19);
        const size = BSON.calculateObjectSize(pack(doc));
        expect(size).toBeLessThan(JSON.stringify(b).length);
    });
});

describe('seasons', () => {
    test('record is the difference with the previous season', () => {
        const codec = memoryCodec();
        let doc = read(null, codec, body([100, 0, 50, 0, 10], 18), day(0), 18);
        doc = read(doc, codec, body([120, 1, 60, 3, 10], 18), day(20), 18); // end of season 18
        doc = read(doc, codec, body([130, 1, 64, 5, 10], 19), day(35), 19);
        doc = read(doc, codec, body([150, 2, 70, 0, 10], 19), day(50), 19);
        const [s19, s18] = decodeProfile(doc, 'x', codec).seasons;
        expect(s19).toMatchObject({ seasonId: 19, wins: 30, draws: 1, losses: 10, complete: true });
        // season 18 has no reading before it: counted from our first one
        expect(s18).toMatchObject({
            seasonId: 18,
            wins: 20,
            draws: 1,
            losses: 10,
            complete: false,
        });
    });

    test('best streak: current streak, capped at the season wins', () => {
        const codec = memoryCodec();
        let doc = read(null, codec, body([100, 0, 50, 6, 12], 18), day(0), 18);
        // season 19 starts while the season-18 streak of 6 goes on: +2 wins → only 2 count
        doc = read(doc, codec, body([102, 0, 50, 8, 12], 19), day(31), 19);
        expect(doc.s.find((s) => s.i === 19)!.bw).toBe(2);
        doc = read(doc, codec, body([111, 0, 51, 9, 12], 19), day(32), 19);
        expect(doc.s.find((s) => s.i === 19)!.bw).toBe(9);
        // streak lost: the best stays
        doc = read(doc, codec, body([112, 0, 53, 1, 12], 19), day(33), 19);
        expect(doc.s.find((s) => s.i === 19)!.bw).toBe(9);
    });

    test('best streak: a new lifetime record between two readings', () => {
        const codec = memoryCodec();
        let doc = read(null, codec, body([100, 0, 50, 0, 12], 18), day(0), 18);
        doc = read(doc, codec, body([105, 0, 50, 0, 12], 19), day(31), 19);
        // 15 straight wins then a loss, all between two readings: only the record shows it
        doc = read(doc, codec, body([121, 0, 51, 1, 15], 19), day(32), 19);
        expect(doc.s.find((s) => s.i === 19)!.bw).toBe(15);
    });

    test('old readings imported after newer ones', () => {
        const codec = memoryCodec();
        let doc = read(null, codec, body([200, 0, 90, 4, 15], 20), day(70), 20);
        doc = read(doc, codec, body([150, 0, 70, 3, 15], 19), day(50), 19);
        doc = read(doc, codec, body([120, 0, 60, 0, 10], 18), day(20), 18);
        // current fields keep the newest reading
        expect(doc.r[0]).toBe(200);
        expect(doc.t).toEqual(day(70));
        const [s20, s19] = decodeProfile(doc, 'x', codec).seasons;
        expect(s20).toMatchObject({ wins: 50, losses: 20, complete: true });
        expect(s19).toMatchObject({ wins: 30, losses: 10, complete: true });
        // record went 10 → 15 between the season-18 and season-19 readings
        expect(doc.s.find((s) => s.i === 19)!.bw).toBe(15);
    });

    test('reading outside any season only updates the current fields', () => {
        const codec = memoryCodec();
        let doc = read(null, codec, body([100, 0, 50, 0, 10]), day(0), 19);
        doc = read(doc, codec, body([101, 0, 50, 1, 10]), day(1), null);
        expect(doc.r[0]).toBe(101);
        expect(doc.s).toHaveLength(1);
        expect(doc.s[0]!.r1[0]).toBe(100);
    });
});

describe('streakFromReading', () => {
    test('no cap for a player new to us', () => {
        expect(streakFromReading([10, 0, 0, 7, 9], null, null)).toBe(7);
    });
});
