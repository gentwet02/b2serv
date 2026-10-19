import { getStoredAvatars } from '@/services/profileStore';
import { fixAssetUrl } from '@/utils/assets';

/**
 * Avatars for the client, from the stored profiles only: a visitor never causes a request to
 * Ninja Kiwi. Missing ones arrive with the next profile sweep (profileSweep.ts).
 */

/** Avatar link of each player with a stored profile. */
export async function getKnownAvatars(ids: string[]): Promise<Record<string, string>> {
    const avatars = await getStoredAvatars(ids);
    for (const id of Object.keys(avatars)) avatars[id] = fixAssetUrl(avatars[id]!);
    return avatars;
}

/** GET /avatars: `pending` stays empty, kept for clients that still read it. */
export async function requestAvatars(ids: string[]) {
    return { avatars: await getKnownAvatars(ids), pending: [] as string[] };
}
