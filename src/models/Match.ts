import { model, Schema } from 'mongoose';
import {
    ApiAssetUrl,
    ApiDataUrl,
    GameType,
    Hero,
    MapName,
    Result,
    Round,
    SeasonId,
    Tower,
} from '@/validators';

const matchPlayerSchema = new Schema(
    {
        displayName: String,
        hero: Hero,
        towerone: Tower,
        towertwo: Tower,
        towerthree: Tower,
        result: Result,
        profileURL: ApiDataUrl,
    },
    { _id: false }
);

const matchSchema = new Schema({
    timeStamp: Date,
    seasonId: SeasonId,
    id: String,
    gametype: GameType,
    mapName: MapName,
    duration: Number,
    endRound: Round,
    playerLeft: matchPlayerSchema,
    playerRight: matchPlayerSchema,
});

export const Match = model('Match', matchSchema);
