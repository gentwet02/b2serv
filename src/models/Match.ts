import { Schema } from 'mongoose';
import { MatchResultCodes, TowerCodes, UserId } from '@/validators';

const matchPlayerSchema = new Schema(
    {
        t: TowerCodes,
        i: UserId,
    },
    { _id: false },
);

export const matchSchema = new Schema(
    {
        t: Number,
        i: String,
        d: MatchResultCodes,
        pl: matchPlayerSchema,
        pr: matchPlayerSchema,
    },
    { versionKey: false },
);

matchSchema.index({ i: 1 }, { unique: true });
matchSchema.index({ 'pl.i': 1 });
matchSchema.index({ 'pr.i': 1 });
matchSchema.index({ t: -1 });
