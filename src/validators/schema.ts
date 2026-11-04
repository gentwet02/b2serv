import { Schema, type SchemaDefinitionProperty } from 'mongoose';
import { GAME_RESULTS, GAME_TYPES } from '@/config/matches';
import { NK_USER_ID } from '@/config/nk';
import { TOWERS } from '@/config/towers';
import { isHero } from '@/validators/match';
import { isNkApiUrl, isNkAssetUrl } from '@/validators/nk';

/**
 * Field definitions for mongoose schemas. A failing check rejects the whole write, so use the
 * NK-value fields only for data the server controls: NK's own answers are checked with
 * validators/match.ts and kept even when something is new.
 */

type Field = SchemaDefinitionProperty;

export const Required = {
    String: { type: String, required: true },
    Number: { type: Number, required: true },
    Int32: { type: Schema.Types.Int32, required: true },
    Boolean: { type: Boolean, required: true },
    Date: { type: Date, required: true },
    Buffer: { type: Buffer, required: true },
    Mixed: { type: Schema.Types.Mixed, required: true },
} satisfies Record<string, Field>;

export const NkFields = {
    UserId: { type: String, match: NK_USER_ID },
    ApiUrl: {
        type: String,
        validate: { validator: isNkApiUrl, message: 'Not an NK API url' },
    },
    AssetUrl: {
        type: String,
        validate: { validator: isNkAssetUrl, message: 'Not an NK asset url' },
    },
    Hero: { type: String, validate: { validator: isHero, message: 'Unknown hero' } },
    Tower: { type: String, enum: TOWERS },
    GameType: { type: String, enum: GAME_TYPES },
    Result: { type: String, enum: GAME_RESULTS },
} satisfies Record<string, Field>;

export const MatchFields = {
    SeasonId: { type: Schema.Types.Int32, min: 1 },
    Round: { type: Schema.Types.Int32, min: 1, max: 100 },
    RoundRanked: { type: Schema.Types.Int32, min: 1, max: 50 },
} satisfies Record<string, Field>;
