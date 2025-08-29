import { model, Schema } from 'mongoose';
import { Required } from '@/database/validators';

const matchPlayerSchema = new Schema(
    {
        displayName: Required.String,
        hero: Required.Hero,
        heroPortrait: Required.ApiAssetUrl,
        towerone: Required.Tower,
        towertwo: Required.Tower,
        towerthree: Required.Tower,
        currentUser: Required.Boolean,
        result: Required.Result,
        profileURL: Required.ApiDataUrl,
    },
    { _id: false, required: true }
);

const matchSchema = new Schema({
    timeStamp: Required.Date,
    seasonId: Required.SeasonId,
    matchId: Required.String,
    gametype: Required.GameType,
    mapName: Required.MapName,
    duration: Required.Int32,
    endRound: Required.Round,
    mapURL: Required.ApiAssetUrl,
    playerLeft: matchPlayerSchema,
    playerRight: matchPlayerSchema,
});

export const Match = model('Match', matchSchema);
