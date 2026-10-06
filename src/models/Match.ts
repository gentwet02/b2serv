import { Schema } from 'mongoose';
import { MatchResultCodes, SeasonId, TowerCodes, UserId } from '@/validators';

const matchPlayerSchema = new Schema(
    {
        t: TowerCodes,
        i: UserId,
    },
    { _id: false }
);

export const matchSchema = new Schema(
    {
        t: Number,
        i: String,
        d: MatchResultCodes,
        pl: matchPlayerSchema,
        pr: matchPlayerSchema,
    },
    { versionKey: false }
);
