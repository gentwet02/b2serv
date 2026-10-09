/**
 * NK's animated avatars are dead links. Each has a static twin with the same name and
 * another hash:
 *   6ed5a240…_look_of_doom_avatar_animated.png  →  d7c9cd31…_look_of_doom_avatar.png
 *   29ecc2c9…_rideemcowboy_animatedavatar.png   →  e3a0d723…_rideemcowboy_avatar.png
 * NK has no list of assets, so the static links are learned from the profiles the server sees
 * (stored ones at startup, then every profile fetched or served).
 * GET /info/assets lists the animated ones with no static twin seen yet under `missing`.
 */

/** …/<32 hex hash>_<file name>.<ext> */
const ASSET_FILE = /\/[0-9a-f]{32}_(.+)\.(png|jpe?g|webp|gif)$/i;

/**
 * Where NK puts "animated" in a file name: `_animated` at the end, or glued to
 * avatar/banner/border on either side (avatar_animated, avataranimated, animatedavatar,
 * animated_avatar). A name that merely contains "animated" elsewhere stays static.
 */
const ANIMATED =
    /_animated$|animated(?=_?(?:avatar|banner|border)$)|(?<=(?:avatar|banner|border)_?)animated$/;

/** name → static link */
const staticByName = new Map<string, string>();
/** animated links seen with no static twin known yet */
const unresolved = new Set<string>();

function parse(url: string) {
    const match = ASSET_FILE.exec(url);
    if (!match) return null;
    const file = match[1].toLowerCase();
    if (!ANIMATED.test(file)) return { name: file, animated: false };
    // drop "animated" and the underscore it leaves behind: rideemcowboy_animatedavatar → rideemcowboy_avatar
    const name = file.replace(ANIMATED, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
    return { name, animated: true };
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
    } else if (!staticByName.has(asset.name)) {
        unresolved.add(url);
    }
}

/** The working link for an NK asset (avatar, banner, border). */
export function fixAssetUrl(url: string): string;
export function fixAssetUrl(url: string | undefined): string | undefined {
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
        /** animated links with no static twin seen yet */
        missing: [...unresolved].sort(),
    };
}
