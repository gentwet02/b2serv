/**
 * NK asset links that are dead, and a working image to show instead.
 * Add a line whenever you find another one.
 */
const REPLACEMENTS: Record<string, string> = {
    'https://static-api.nkstatic.com/appdocs/4/assets/opendata/6ed5a24051802fe844e2752b8e2921c8_look_of_doom_avatar_animated.png':
        'https://static-api.nkstatic.com/appdocs/4/assets/opendata/d7c9cd31c606931c820c46e595a1d54e_look_of_doom_avatar.png',
};

/** The working link for an NK asset (avatar, banner, border). */
export function fixAssetUrl(url: string): string;
export function fixAssetUrl(url: string | undefined): string | undefined;
export function fixAssetUrl(url: string | undefined) {
    return url ? (REPLACEMENTS[url] ?? url) : url;
}

const ASSET_FIELDS = ['equippedAvatarURL', 'equippedBannerURL', 'equippedBorderURL'] as const;

/** An NK profile answer with its dead asset links replaced (returns a copy). */
export function fixProfileAssets<T extends { body?: unknown }>(data: T): T {
    if (!data.body || typeof data.body !== 'object') return data;
    const body = { ...(data.body as Record<string, unknown>) };
    for (const field of ASSET_FIELDS) {
        if (typeof body[field] === 'string') body[field] = fixAssetUrl(body[field]);
    }
    return { ...data, body };
}
