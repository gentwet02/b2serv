/**
 * NK's animated avatars (…_animated.png) are dead links. Each has a static twin with the same
 * name and another hash:
 *   6ed5a240…_look_of_doom_avatar_animated.png  →  d7c9cd31…_look_of_doom_avatar.png
 * NK has no list of assets, so the static links are learned from the profiles the server sees
 * (stored ones at startup, then every profile fetched or served). REPLACEMENTS is for the
 * animated ones whose static twin no player in our data has equipped yet:
 * GET /info/assets lists those under `missing`.
 */

/** …/<32 hex hash>_<name>[_animated].<ext> */
const ASSET_FILE = /\/[0-9a-f]{32}_(.+?)(_?animated)?\.(png|jpe?g|webp|gif)$/i;

/** name → static link */
const staticByName = new Map<string, string>();
/** animated links seen with no static twin known yet */
const unresolved = new Set<string>();

function parse(url: string) {
    const match = ASSET_FILE.exec(url);
    return match ? { name: match[1].toLowerCase(), animated: !!match[2] } : null;
}

/** Records a link we saw in a profile. */
export function learnAssetUrl(url: string | undefined) {
    if (!url) return;
    const asset = parse(url);
    if (!asset) return;
    if (!asset.animated) {
        if (staticByName.has(asset.name)) return;
        staticByName.set(asset.name, url);
        for (const u of unresolved) if (parse(u)?.name === asset.name) unresolved.delete(u);
    }
}

/** The working link for an NK asset (avatar, banner, border). */
export function fixAssetUrl(url: string): string;
export function fixAssetUrl(url: string | undefined): string | undefined;
export function fixAssetUrl(url: string | undefined) {
    if (!url) return url;
    learnAssetUrl(url);
    const asset = parse(url);
    return (asset?.animated && staticByName.get(asset.name)) || url;
}

const ASSET_FIELDS = ['equippedAvatarURL', 'equippedBannerURL', 'equippedBorderURL'] as const;

/** Learns every asset link of an NK profile answer. */
export function learnProfileAssets(data: unknown) {
    const body = (data as { body?: Record<string, unknown> } | null)?.body;
    if (!body || typeof body !== 'object') return;
    for (const field of ASSET_FIELDS) {
        if (typeof body[field] === 'string') learnAssetUrl(body[field]);
    }
}

/** An NK profile answer with its dead asset links replaced (returns a copy). */
export function fixProfileAssets<T extends { body?: unknown }>(data: T): T {
    if (!data.body || typeof data.body !== 'object') return data;
    const body = { ...(data.body as Record<string, unknown>) };
    for (const field of ASSET_FIELDS) {
        if (typeof body[field] === 'string') body[field] = fixAssetUrl(body[field]);
    }
    return { ...data, body };
}

/** What the index knows, for GET /info/assets. */
export function getAssetReport() {
    return {
        /** every static asset seen, by name */
        static: Object.fromEntries([...staticByName].sort(([a], [b]) => a.localeCompare(b))),
        /** animated links with no static twin seen yet: add them to REPLACEMENTS by hand */
        missing: [...unresolved].sort(),
    };
}
