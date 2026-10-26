import mongoose from 'mongoose';
import type { ProfileCodeKind } from '@/services/codeBook';
import type {
    NkBadge,
    NkProfileBody,
    NkStats,
    ProfileDoc,
    ProfileSeason,
    ProfileSeasonDoc,
    RankedPoint,
    StoredProfileDoc,
} from '@/types/profile';

/**
 * The stored profile format, without any database access (profileStore.ts does the I/O).
 *
 * Every repeated string (asset files, titles, badges, arenas, towers, bloons, accolades,
 * guilds) becomes a number from the code book; lists become packed varints. The player's
 * name lives in player_codes. A full NK profile (4–5 KB of JSON) comes down to a few hundred
 * bytes, plus ~80 bytes per season.
 *
 * Seasons: NK's ranked stats are lifetime numbers and never reset, so each reading is filed
 * under the season live at that time, keeping the first and last lifetime numbers seen in it.
 * A season's wins/draws/losses = its last reading − the previous season's last reading.
 */

export interface Codec {
    /** code of a name that was made sure of beforehand (ensureCodes) */
    code(kind: ProfileCodeKind, name: string): number;
    name(kind: ProfileCodeKind, code: number): string | undefined;
}

export const ASSET_PREFIX = 'https://static-api.nkstatic.com/appdocs/4/assets/opendata/';
const GUILD_PREFIX = 'https://data.ninjakiwi.com/battles2/guild/';
const BADGE_SEP = '\u001f';

/** NK's asset link → what we code: the file name when it's on NK's usual host. */
export const assetKey = (url: string) =>
    url.startsWith(ASSET_PREFIX) ? url.slice(ASSET_PREFIX.length) : url;
export const assetUrl = (key: string) => (/^https?:\/\//.test(key) ? key : ASSET_PREFIX + key);
/** "e00f…_mastery_spikefactory_avatar.png" → "mastery_spikefactory_avatar" */
export const assetName = (key: string) =>
    (key.split('/').pop() ?? key).replace(/^[0-9a-f]{32}_/i, '').replace(/\.[a-z0-9]+$/i, '');

// ---------------------------------------------------------------------------
// varints
// ---------------------------------------------------------------------------

/** Unsigned LEB128. Negative or fractional values are clamped/rounded to a whole number ≥ 0. */
export function packVarints(values: number[]): Buffer {
    const out: number[] = [];
    for (const raw of values) {
        let v = Math.max(0, Math.round(Number(raw) || 0));
        while (v >= 0x80) {
            out.push((v % 0x80) | 0x80);
            v = Math.floor(v / 0x80);
        }
        out.push(v);
    }
    return Buffer.from(out);
}

export function unpackVarints(buf: Uint8Array): number[] {
    const values: number[] = [];
    let v = 0;
    let scale = 1;
    for (const byte of buf) {
        v += (byte & 0x7f) * scale;
        if (byte & 0x80) scale *= 0x80;
        else {
            values.push(v);
            v = 0;
            scale = 1;
        }
    }
    return values;
}

const toBinary = (values: number[]) =>
    values.length > 0 ? new mongoose.mongo.Binary(packVarints(values)) : undefined;

function fromBinary(bin: mongoose.mongo.Binary | undefined): number[] {
    if (!bin) return [];
    return unpackVarints(bin.buffer.subarray(0, bin.length()));
}

// ---------------------------------------------------------------------------
// names to code before encoding
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function readBadge(item: unknown): { season: number | null; key: string } | null {
    if (typeof item === 'string' && item) return { season: null, key: item };
    if (!item || typeof item !== 'object') return null;
    const badge = item as NkBadge;
    const name = str(badge.name) ?? '';
    const icon = str(badge.iconURL);
    if (!name && !icon) return null;
    const season = typeof badge.season === 'number' ? badge.season : null;
    return { season, key: icon ? `${name}${BADGE_SEP}${assetKey(icon)}` : name };
}

const guildKey = (url: string) =>
    url.startsWith(GUILD_PREFIX) ? url.slice(GUILD_PREFIX.length) : url;

/** Every name a profile needs a code for, by kind. */
export function profileNames(body: NkProfileBody): Map<ProfileCodeKind, Set<string>> {
    const names = new Map<ProfileCodeKind, Set<string>>();
    const add = (kind: ProfileCodeKind, name: string | undefined) => {
        if (!name) return;
        const set = names.get(kind) ?? new Set<string>();
        set.add(name);
        names.set(kind, set);
    };
    const avatar = str(body.equippedAvatarURL);
    const banner = str(body.equippedBannerURL);
    const border = str(body.equippedBorderURL);
    add('avatar', avatar && assetKey(avatar));
    add('banner', banner && assetKey(banner));
    add('border', border && assetKey(border));
    add('title', str(body.equippedTitle));
    for (const item of body.badges_equipped ?? []) add('badge', readBadge(item)?.key);
    for (const item of body.badges_all ?? []) add('badge', readBadge(item)?.key);
    add('arena', str(body.currentSeason_highestArena));
    add('arena', str(body.lifetime_highestArena));
    const guild = str(body.guild);
    if (body.inGuild && guild) add('guild', guildKey(guild));
    for (const t of body._towers ?? []) add('unit', str(t?.type));
    for (const b of body._bloonStats ?? []) add('bloon', str(b?.bloon_type));
    for (const a of body.accolades ?? []) {
        add('accolade', str(a?.type));
        add('accolade', str(a?.subtype));
    }
    return names;
}

// ---------------------------------------------------------------------------
// encode one reading
// ---------------------------------------------------------------------------

const STAT_KEYS: (keyof NkStats)[] = [
    'wins',
    'draws',
    'losses',
    'win_streak',
    'highest_win_streak',
    'no_lives_lost',
    'first_bloons',
];
const stats = (s: Partial<NkStats> | undefined) => STAT_KEYS.map((k) => num(s?.[k]));
const rankedPoint = (r: number[]): RankedPoint => [r[0]!, r[1]!, r[2]!, r[3]!, r[4]!];

/** "season_19" → 19 */
export function nkSeasonNumber(value: unknown): number | null {
    const match = /^season_(\d+)$/.exec(String(value ?? ''));
    return match ? Number(match[1]) : null;
}

/** The current-state part of a document (everything but _id, t and seasons). */
export function encodeCurrent(body: NkProfileBody, codec: Codec) {
    const opt = (kind: ProfileCodeKind, name: string | undefined) =>
        name ? codec.code(kind, name) : -1;
    const avatar = str(body.equippedAvatarURL);
    const banner = str(body.equippedBannerURL);
    const border = str(body.equippedBorderURL);
    const e = [
        opt('avatar', avatar && assetKey(avatar)),
        opt('banner', banner && assetKey(banner)),
        opt('border', border && assetKey(border)),
        opt('title', str(body.equippedTitle)),
    ];

    /** [season + 1, badge code, …] */
    const badgeCodes = (items: unknown[] | undefined) => {
        const out: number[] = [];
        for (const item of items ?? []) {
            const badge = readBadge(item);
            if (badge)
                out.push(
                    badge.season === null ? 0 : badge.season + 1,
                    codec.code('badge', badge.key),
                );
        }
        return out;
    };
    const g = badgeCodes(body.badges_equipped);
    const ga = badgeCodes(body.badges_all);

    const guild = str(body.guild);
    const inGuild = !!body.inGuild;
    const f = (body.is_vip ? 1 : 0) | (body.is_club_member ? 2 : 0) | (inGuild ? 4 : 0);

    const season = nkSeasonNumber(body.currentSeason);
    const a = [
        season === null ? 0 : season + 1,
        num(body.currentSeason_trophies),
        opt('arena', str(body.currentSeason_highestArena)) + 1,
        num(body.currentSeason_highestArenaIndex),
        num(body.lifetime_trophies),
        opt('arena', str(body.lifetime_highestArena)) + 1,
        num(body.lifetime_highestArenaIndex),
        num(body.arenaLeagueTier),
        num(body.chestsOpened),
    ];

    const units: number[] = [];
    for (const t of body._towers ?? []) {
        const type = str(t?.type);
        if (type) units.push(codec.code('unit', type), num(t.used) * 2 + (t.unlocked ? 1 : 0));
    }
    const bloons: number[] = [];
    for (const b of body._bloonStats ?? []) {
        const type = str(b?.bloon_type);
        if (type) bloons.push(codec.code('bloon', type), num(b.sends), num(b.pops));
    }
    const accolades: number[] = [];
    for (const x of body.accolades ?? []) {
        const type = str(x?.type);
        if (!type) continue;
        const subtype = str(x.subtype);
        accolades.push(
            codec.code('accolade', type),
            subtype ? codec.code('accolade', subtype) + 1 : 0,
            num(x.value),
        );
    }

    const current: Omit<ProfileDoc, '_id' | 't' | 's'> = {
        e,
        f,
        r: stats(body.rankedStats),
        c: stats(body.casualStats),
        a,
    };
    if (g.length) current.g = g;
    if (ga.length) current.ga = ga;
    if (inGuild && guild) current.gu = codec.code('guild', guildKey(guild));
    const u = toBinary(units);
    const b = toBinary(bloons);
    const k = toBinary(accolades);
    if (u) current.u = u;
    if (b) current.b = b;
    if (k) current.k = k;
    return current;
}

// ---------------------------------------------------------------------------
// seasons
// ---------------------------------------------------------------------------

/** The season before `seasonId` we have a reading for. */
const previousSeason = (seasons: ProfileSeasonDoc[], seasonId: number) =>
    seasons.filter((s) => s.i < seasonId).sort((a, b) => b.i - a.i)[0];

/** Latest lifetime reading taken before `date`, across every season. */
function readingBefore(doc: ProfileDoc | null, seasons: ProfileSeasonDoc[], date: Date) {
    let best: { t: number; r: RankedPoint } | null = null;
    const candidates: [Date, RankedPoint][] = seasons.flatMap((s): [Date, RankedPoint][] => [
        [s.t0, s.r0],
        [s.t1, s.r1],
    ]);
    if (doc) candidates.push([doc.t, rankedPoint(doc.r)]);
    {
        for (const [t, r] of candidates) {
            const time = new Date(t).getTime();
            if (time < date.getTime() && (!best || time > best.t)) best = { t: time, r };
        }
    }
    return best?.r ?? null;
}

/**
 * Wins this season at reading `r`, from the previous season's last reading.
 * null when we have no reading from before the season (a player new to us).
 */
function seasonWins(seasons: ProfileSeasonDoc[], seasonId: number, r: RankedPoint) {
    const prev = previousSeason(seasons, seasonId);
    return prev ? Math.max(0, r[0] - prev.r1[0]) : null;
}

/**
 * Best win streak of the season, from what one reading shows:
 *  - the current streak (capped at the season's wins, so a streak that began last season
 *    is only counted for its part in this one);
 *  - the lifetime best, when it went up since the previous reading: that record was set
 *    since then (same cap).
 * Streaks that started and ended between two readings can't be seen: readings are taken
 * often (profile sweep) to keep that window short.
 */
export function streakFromReading(
    r: RankedPoint,
    before: RankedPoint | null,
    wins: number | null,
): number {
    const cap = (n: number) => (wins === null ? n : Math.min(n, wins));
    let best = cap(r[3]);
    if (before && r[4] > before[4]) best = Math.max(best, cap(r[4]));
    return best;
}

export interface Reading {
    body: NkProfileBody;
    date: Date;
    /** season live when the reading was taken; null outside any season (no season update) */
    seasonId: number | null;
}

/**
 * A document with one more reading. Readings can come in any order (imports of old data):
 * the current fields only follow the newest one, a season keeps its first and last.
 */
export function applyReading(doc: ProfileDoc | null, code: number, reading: Reading, codec: Codec) {
    const { body, date, seasonId } = reading;
    const current = encodeCurrent(body, codec);
    const seasons = (doc?.s ?? []).map((s) => ({ ...s }));
    const newest = !doc || date.getTime() >= new Date(doc.t).getTime();

    if (seasonId !== null) {
        const r = rankedPoint(current.r);
        const before = readingBefore(doc, seasons, date);
        const wins = seasonWins(seasons, seasonId, r);
        const streak = streakFromReading(r, before, wins);

        const entry = seasons.find((s) => s.i === seasonId);
        if (!entry) {
            const fresh: ProfileSeasonDoc = {
                i: seasonId,
                t0: date,
                t1: date,
                r0: r,
                r1: r,
                bw: streak,
                e: current.e,
            };
            if (current.g) fresh.g = current.g;
            seasons.push(fresh);
            seasons.sort((a, b) => a.i - b.i);
        } else {
            entry.bw = Math.max(entry.bw, streak);
            if (date.getTime() < new Date(entry.t0).getTime()) {
                entry.t0 = date;
                entry.r0 = r;
            }
            if (date.getTime() >= new Date(entry.t1).getTime()) {
                entry.t1 = date;
                entry.r1 = r;
                entry.e = current.e;
                if (current.g) entry.g = current.g;
                else delete entry.g;
            }
        }
    }

    // an older reading added later can give the seasons after it a reading to compare with
    if (seasonId !== null) {
        for (const s of seasons) {
            if (s.i <= seasonId) continue;
            for (const [t, r] of [
                [s.t0, s.r0],
                [s.t1, s.r1],
            ] as const) {
                const at = new Date(t);
                const found = streakFromReading(
                    r,
                    readingBefore(null, seasons, at),
                    seasonWins(seasons, s.i, r),
                );
                s.bw = Math.max(s.bw, found);
            }
        }
    }

    // old dumps have no badges_all: keep the list we had rather than dropping it
    if (newest && doc?.ga && !current.ga && body.badges_all === undefined) current.ga = doc.ga;
    const next: ProfileDoc =
        newest || !doc ? { _id: code, t: date, ...current, s: seasons } : { ...doc, s: seasons };
    return next;
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

/** [season + 1, badge code, …] → badges as NK sends them */
function decodeBadges(g: number[] | undefined, codec: Codec) {
    const badges: { season: number | null; name: string; iconURL: string | null }[] = [];
    for (let i = 0; g && i + 1 < g.length; i += 2) {
        const key = codec.name('badge', g[i + 1]!);
        if (!key) continue;
        const [name, icon] = key.split(BADGE_SEP);
        badges.push({
            season: g[i]! > 0 ? g[i]! - 1 : null,
            name: name ?? '',
            iconURL: icon ? assetUrl(icon) : null,
        });
    }
    return badges;
}

function decodeEquipped(e: number[], g: number[] | undefined, codec: Codec) {
    const asset = (kind: ProfileCodeKind, code: number | undefined) => {
        if (code === undefined || code < 0) return null;
        const key = codec.name(kind, code);
        return key ? { key, url: assetUrl(key), name: assetName(key) } : null;
    };
    const titleCode = e[3];
    const badges = decodeBadges(g, codec);
    return {
        avatar: asset('avatar', e[0]),
        banner: asset('banner', e[1]),
        border: asset('border', e[2]),
        title:
            titleCode !== undefined && titleCode >= 0
                ? (codec.name('title', titleCode) ?? null)
                : null,
        badges,
    };
}

const statsOf = (s: number[]): NkStats => ({
    wins: s[0] ?? 0,
    draws: s[1] ?? 0,
    losses: s[2] ?? 0,
    win_streak: s[3] ?? 0,
    highest_win_streak: s[4] ?? 0,
    no_lives_lost: s[5] ?? 0,
    first_bloons: s[6] ?? 0,
});

/** The season records of a document, newest first. */
export function decodeSeasons(doc: ProfileDoc, codec: Codec): ProfileSeason[] {
    return doc.s
        .map((s): ProfileSeason => {
            const prev = previousSeason(doc.s, s.i);
            const base = prev ?? null;
            const from = base ? base.r1 : s.r0;
            const equipped = decodeEquipped(s.e, s.g, codec);
            return {
                seasonId: s.i,
                wins: Math.max(0, s.r1[0] - from[0]),
                draws: Math.max(0, s.r1[1] - from[1]),
                losses: Math.max(0, s.r1[2] - from[2]),
                winStreak: s.r1[3],
                bestWinStreak: s.bw,
                // the previous reading must close the season right before this one
                complete: !!base && base.i === s.i - 1,
                equipped: {
                    avatar: equipped.avatar?.url ?? null,
                    banner: equipped.banner?.url ?? null,
                    border: equipped.border?.url ?? null,
                    title: equipped.title,
                    badges: equipped.badges,
                },
                firstSeen: new Date(s.t0).toISOString(),
                lastSeen: new Date(s.t1).toISOString(),
            };
        })
        .sort((a, b) => b.seasonId - a.seasonId);
}

/**
 * The document as the NK profile body the client already reads, plus our season records.
 * Links to NK endpoints (matches, homs, guild) aren't kept.
 */
export function decodeProfile(doc: ProfileDoc, displayName: string, codec: Codec) {
    const equipped = decodeEquipped(doc.e, doc.g, codec);
    const arena = (code: number | undefined) => (code ? (codec.name('arena', code - 1) ?? '') : '');
    const a = doc.a;

    const units = fromBinary(doc.u);
    const towers = [];
    for (let i = 0; i + 1 < units.length; i += 2) {
        towers.push({
            type: codec.name('unit', units[i]!) ?? 'Unknown',
            used: Math.floor(units[i + 1]! / 2),
            unlocked: units[i + 1]! % 2 === 1,
        });
    }
    const bloonValues = fromBinary(doc.b);
    const bloons = [];
    for (let i = 0; i + 2 < bloonValues.length; i += 3) {
        bloons.push({
            bloon_type: codec.name('bloon', bloonValues[i]!) ?? 'Unknown',
            sends: bloonValues[i + 1]!,
            pops: bloonValues[i + 2]!,
        });
    }
    const accoladeValues = fromBinary(doc.k);
    const accolades = [];
    for (let i = 0; i + 2 < accoladeValues.length; i += 3) {
        const sub = accoladeValues[i + 1]!;
        accolades.push({
            type: codec.name('accolade', accoladeValues[i]!) ?? 'Unknown',
            subtype: sub > 0 ? (codec.name('accolade', sub - 1) ?? 'None') : 'None',
            value: accoladeValues[i + 2]!,
        });
    }
    const guild = doc.gu !== undefined ? codec.name('guild', doc.gu) : undefined;

    return {
        displayName,
        is_vip: (doc.f & 1) !== 0,
        is_club_member: (doc.f & 2) !== 0,
        equippedAvatar: equipped.avatar?.name ?? '',
        equippedAvatarURL: equipped.avatar?.url ?? '',
        equippedBanner: equipped.banner?.name ?? '',
        equippedBannerURL: equipped.banner?.url ?? '',
        equippedBorder: equipped.border?.name ?? '',
        equippedBorderURL: equipped.border?.url ?? '',
        equippedTitle: equipped.title ?? 'None',
        casualStats: statsOf(doc.c),
        rankedStats: statsOf(doc.r),
        badges_equipped: equipped.badges,
        badges_all: decodeBadges(doc.ga, codec),
        chestsOpened: a[8] ?? 0,
        currentSeason: a[0] ? `season_${a[0] - 1}` : 'none',
        currentSeason_trophies: a[1] ?? 0,
        currentSeason_highestArena: arena(a[2]),
        currentSeason_highestArenaIndex: a[3] ?? 0,
        lifetime_trophies: a[4] ?? 0,
        lifetime_highestArena: arena(a[5]),
        lifetime_highestArenaIndex: a[6] ?? 0,
        arenaLeagueTier: a[7] ?? 0,
        inGuild: (doc.f & 4) !== 0,
        guild: guild ? GUILD_PREFIX + guild : null,
        accolades,
        _bloonStats: bloons,
        _towers: towers,
        seasons: decodeSeasons(doc, codec),
    };
}

/** The equipped avatar link of a document, if any. */
export function avatarOf(doc: Pick<ProfileDoc, 'e'>, codec: Codec): string | null {
    const code = doc.e?.[0];
    if (code === undefined || code < 0) return null;
    const key = codec.name('avatar', code);
    return key ? assetUrl(key) : null;
}

// ---------------------------------------------------------------------------
// storage: everything numeric packed as varints
// ---------------------------------------------------------------------------

const FORMAT = 1;
const minutes = (d: Date) => Math.floor(new Date(d).getTime() / 60_000);
const fromMinutes = (m: number) => new Date(m * 60_000);
const plusOne = (values: number[]) => values.map((v) => v + 1);
const minusOne = (values: number[]) => values.map((v) => v - 1);

/**
 * Current numbers:
 *   [format, flags, guild code + 1 (0 none), e+1 ×4, ranked ×7, casual ×7, a ×9,
 *    badge count n, (badge season + 1, badge code) ×n,
 *    all badges count m, (badge season + 1, badge code) ×m]
 * The all-badges list came later: documents without it end after the equipped badges and
 * read as an empty list (the cursor gives 0 past the end).
 */
function packCurrent(doc: ProfileDoc): number[] {
    const g = doc.g ?? [];
    const ga = doc.ga ?? [];
    return [
        FORMAT,
        doc.f,
        doc.gu === undefined ? 0 : doc.gu + 1,
        ...plusOne(pad(doc.e, 4, -1)),
        ...pad(doc.r, 7, 0),
        ...pad(doc.c, 7, 0),
        ...pad(doc.a, 9, 0),
        g.length / 2,
        ...g,
        ga.length / 2,
        ...ga,
    ];
}

/**
 * One season:
 *   [season id, t0 and t1 in minutes, r0 ×5, r1 ×5, best streak, e+1 ×4,
 *    badge count n, (badge season + 1, badge code) ×n]
 */
function packSeason(s: ProfileSeasonDoc): number[] {
    const g = s.g ?? [];
    return [
        s.i,
        minutes(s.t0),
        minutes(s.t1),
        ...s.r0,
        ...s.r1,
        s.bw,
        ...plusOne(pad(s.e, 4, -1)),
        g.length / 2,
        ...g,
    ];
}

function pad(values: number[], length: number, fill: number) {
    return Array.from({ length }, (_, i) => values[i] ?? fill);
}

/** Reads numbers off a list in order. */
function cursor(values: number[]) {
    let at = 0;
    return {
        one: () => values[at++] ?? 0,
        many: (n: number) => {
            const out = values.slice(at, at + n);
            at += n;
            while (out.length < n) out.push(0);
            return out;
        },
    };
}

export function pack(doc: ProfileDoc): StoredProfileDoc {
    const stored: StoredProfileDoc = {
        _id: doc._id,
        t: doc.t,
        v: new mongoose.mongo.Binary(packVarints(packCurrent(doc))),
    };
    if (doc.u) stored.u = doc.u;
    if (doc.b) stored.b = doc.b;
    if (doc.k) stored.k = doc.k;
    if (doc.s.length)
        stored.s = doc.s.map((s) => new mongoose.mongo.Binary(packVarints(packSeason(s))));
    return stored;
}

export function unpack(stored: StoredProfileDoc): ProfileDoc {
    const v = cursor(fromBinary(stored.v));
    const format = v.one();
    if (format !== FORMAT)
        throw new Error(`Unknown profile format ${format} (player ${stored._id})`);
    const f = v.one();
    const gu = v.one();
    const doc: ProfileDoc = {
        _id: stored._id,
        t: new Date(stored.t),
        f,
        e: minusOne(v.many(4)),
        r: v.many(7),
        c: v.many(7),
        a: v.many(9),
        s: [],
    };
    const g = v.many(v.one() * 2);
    if (g.length) doc.g = g;
    const ga = v.many(v.one() * 2);
    if (ga.length) doc.ga = ga;
    if (gu > 0) doc.gu = gu - 1;
    if (stored.u) doc.u = stored.u;
    if (stored.b) doc.b = stored.b;
    if (stored.k) doc.k = stored.k;

    for (const bin of stored.s ?? []) {
        const c = cursor(fromBinary(bin));
        const season: ProfileSeasonDoc = {
            i: c.one(),
            t0: fromMinutes(c.one()),
            t1: fromMinutes(c.one()),
            r0: c.many(5) as RankedPoint,
            r1: c.many(5) as RankedPoint,
            bw: c.one(),
            e: minusOne(c.many(4)),
        };
        const sg = c.many(c.one() * 2);
        if (sg.length) season.g = sg;
        doc.s.push(season);
    }
    return doc;
}
