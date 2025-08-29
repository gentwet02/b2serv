import { Schema } from 'mongoose';

export const ApiAssetUrl = {
    type: String,
    validator: (str: string) => {
        return /https:\/\/static-api.nkstatic.com\/appdocs\/4\/assets\/opendata\/.*/.test(str);
    },
};

export const ApiDataUrl = {
    type: String,
    validator: (str: string) => {
        return /https:\/\/data.ninjakiwi.com\/battles2\/.*/.test(str);
    },
};

export const GameType = {
    type: String,
    enum: ['Casual', 'Event', 'GuildWar', 'Ranked'],
};

export const Hero = {
    type: String,
    validator: (str: string) => {
        return /[A-Z][a-z|A-Z|_]*/.test(str);
    },
};

export const MapName = {
    type: String,
    validator: (str: string) => {
        return /[a-z][a-z|_|0-9]*/.test(str);
    },
};

export const Result = {
    type: String,
    enum: ['draw', 'lose', 'win'],
};

export const Round = {
    type: Schema.Types.Int32,
    min: 1,
    max: 100,
};

export const SeasonId = {
    type: Schema.Types.Int32,
    min: 1,
};

export const Tower = {
    type: String,
    enum: [
        'Alchemist',
        'BananaFarm',
        'BombShooter',
        'BoomerangMonkey',
        'DartlingGunner',
        'DartMonkey',
        'Druid',
        'EngineerMonkey',
        'GlueGunner',
        'HeliPilot',
        'IceMonkey',
        'MonkeyAce',
        'MonkeyBuccaneer',
        'MonkeySub',
        'MonkeyVillage',
        'MortarMonkey',
        'NinjaMonkey',
        'SniperMonkey',
        'SpikeFactory',
        'SuperMonkey',
        'TackShooter',
        'WizardMonkey',
    ],
};

export const Required = {
    String: { type: String, required: true },
    Number: { type: Number, required: true },
    Date: { type: Date, required: true },
    Buffer: { type: Buffer, required: true },
    Boolean: { type: Boolean, required: true },
    Mixed: { type: Schema.Types.Mixed, required: true },
    ObjectId: { type: Schema.Types.ObjectId, required: true },
    Array: { type: Array, required: true },
    Decimal128: { type: Schema.Types.Decimal128, required: true },
    Map: { type: Map, required: true },
    Schema: { type: Schema, required: true },
    UUID: { type: Schema.Types.UUID, required: true },
    BigInt: { type: BigInt, required: true },
    Double: { type: Schema.Types.Double, required: true },
    Int32: { type: Schema.Types.Int32, required: true },
    ApiAssetUrl: { type: ApiAssetUrl, required: true },
    ApiDataUrl: { type: ApiDataUrl, required: true },
    GameType: { type: GameType, required: true },
    Hero: { type: Hero, required: true },
    MapName: { type: MapName, required: true },
    Result: { type: Result, required: true },
    Round: { type: Round, required: true },
    SeasonId: { type: SeasonId, required: true },
    Tower: { type: Tower, required: true },
};
