import mongoose, { Schema, type Model } from 'mongoose';
import type { Match } from '@/types/match';
import { logger } from '@/utils/logger';

/** Hero portrait and map image URLs seen in nk data/assets, mirrored in memory */

interface AssetDoc {
    kind: 'hero' | 'map';
    key: string;
    url: string;
}

const assetSchema = new Schema<AssetDoc>(
    {
        kind: { type: String, required: true },
        key: { type: String, required: true },
        url: { type: String, required: true },
    },
    { collection: 'nk_assets', versionKey: false },
);
assetSchema.index({ kind: 1, key: 1 }, { unique: true });

const AssetModel =
    (mongoose.models.NkAsset as Model<AssetDoc> | undefined) ??
    mongoose.model<AssetDoc>('NkAsset', assetSchema);

const assets = new Map<string, string>(); // "hero:Quincy" → url
let loaded: Promise<void> | null = null;

function loadAssets() {
    loaded ??= AssetModel.find({}, { _id: 0 })
        .lean()
        .then((docs) => {
            for (const doc of docs) assets.set(`${doc.kind}:${doc.key}`, doc.url);
        })
        .catch((error) => {
            loaded = null;
            logger.error(`Loading asset URLs failed: ${error}`);
        });
    return loaded;
}

export async function getAssetUrl(kind: AssetDoc['kind'], key: string) {
    await loadAssets();
    return assets.get(`${kind}:${key}`);
}

/** Image URLs found in a batch of crawled NK matches. Writes only new ones */
export async function rememberMatchAssets(matches: Match[]) {
    await loadAssets();
    const fresh: AssetDoc[] = [];
    const add = (kind: AssetDoc['kind'], key: string, url?: string) => {
        if (!key || !url || assets.get(`${kind}:${key}`) === url) return;
        assets.set(`${kind}:${key}`, url);
        fresh.push({ kind, key, url });
    };

    for (const match of matches) {
        add('map', match.map, match.mapURL);
        add('hero', match.playerLeft.hero, match.playerLeft.heroPortrait);
        add('hero', match.playerRight.hero, match.playerRight.heroPortrait);
    }
    if (fresh.length === 0) return;

    try {
        await AssetModel.bulkWrite(
            fresh.map((asset) => ({
                updateOne: {
                    filter: { kind: asset.kind, key: asset.key },
                    update: { $set: asset },
                    upsert: true,
                },
            })),
            { ordered: false },
        );
    } catch (error) {
        logger.error(`Saving asset URLs failed: ${error}`);
    }
}
