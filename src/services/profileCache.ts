import mongoose, { Schema, type Model } from 'mongoose';
import { logger } from '@/utils/logger';

/**
 * Last NK profile answer per player, in `profiles`. Lets a profile load instantly
 * even after a restart: the stored copy is shown while a fresh one is fetched.
 *
 * Space (Atlas free tier): copies expire PROFILE_TTL_DAYS after their last refresh
 * (TTL index), and lists the site never shows are not stored.
 */
const PROFILE_TTL_DAYS = 14;
const UNUSED_FIELDS = ['badges_all', 'badges_equipped', 'chests'];
interface ProfileDoc {
    _id: string; // user id
    data: unknown;
    fetchedAt: Date;
}

const profileSchema = new Schema<ProfileDoc>(
    {
        _id: { type: String, required: true },
        data: { type: Schema.Types.Mixed, required: true },
        fetchedAt: { type: Date, required: true },
    },
    { collection: 'profiles', versionKey: false },
);
profileSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: PROFILE_TTL_DAYS * 24 * 3600 });

function slim(data: unknown) {
    if (!data || typeof data !== 'object' || !('body' in data)) return data;
    const body = { ...((data as { body: Record<string, unknown> }).body ?? {}) };
    for (const field of UNUSED_FIELDS) delete body[field];
    return { ...data, body };
}

const ProfileModel =
    (mongoose.models.Profile as Model<ProfileDoc> | undefined) ??
    mongoose.model<ProfileDoc>('Profile', profileSchema);

// autoIndex is off in production: make sure the TTL index exists
let indexed = false;
const ensureTtlIndex = () => {
    if (indexed) return;
    indexed = true;
    ProfileModel.createIndexes().catch((error) => {
        indexed = false;
        logger.error(`Creating the profiles TTL index failed: ${error}`);
    });
};

export async function loadStoredProfile(userId: string) {
    try {
        return await ProfileModel.findById(userId).lean<ProfileDoc>();
    } catch (error) {
        logger.error(`Loading stored profile ${userId} failed: ${error}`);
        return null;
    }
}

export async function storeProfile(userId: string, data: unknown, fetchedAt: Date) {
    ensureTtlIndex();
    try {
        await ProfileModel.updateOne(
            { _id: userId },
            { $set: { data: slim(data), fetchedAt } },
            { upsert: true },
        );
    } catch (error) {
        logger.error(`Storing profile ${userId} failed: ${error}`);
    }
}

/** Several stored profiles at once (missing ones are left out). */
export async function loadStoredProfiles(userIds: string[]) {
    if (userIds.length === 0) return [];
    try {
        return await ProfileModel.find(
            { _id: { $in: userIds } },
            { 'data.body.equippedAvatarURL': 1 },
        ).lean<ProfileDoc[]>();
    } catch (error) {
        logger.error(`Loading stored profiles failed: ${error}`);
        return [];
    }
}

/** Every distinct avatar, banner and border link in the stored profiles. */
export async function listStoredAssetUrls(): Promise<string[]> {
    try {
        const lists = await Promise.all(
            ['equippedAvatarURL', 'equippedBannerURL', 'equippedBorderURL'].map((field) =>
                ProfileModel.distinct(`data.body.${field}`),
            ),
        );
        return lists.flat().filter((url): url is string => typeof url === 'string');
    } catch (error) {
        logger.error(`Listing stored asset links failed: ${error}`);
        return [];
    }
}
