import { Match, MatchPlayer, MatchPlayerDocument } from '@/types/match';
import { extractUserId } from './helpers';
import { LeaderboardPlayer, LeaderboardPlayerEncoded } from '@/types/leaderboard';
import { playerNames } from '@/data/playerNames';

const towerMap: string[] = [
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
];

const heroMap: string[] = [
    'Agent_Jericho',
    'Benjamin',
    'Benjamin_DJ',
    'Churchill',
    'Churchill_Sentai',
    'DartMonkey',
    'Ezili',
    'Ezili_SmudgeCat',
    'Gwendolin',
    'Gwendolin_Science',
    'Highwayman_Jericho',
    'Obyn',
    'Obyn_Ocean',
    'PatFusty',
    'PatFusty_Snowman',
    'Quincy',
    'Quincy_Cyber',
    'StrikerJones',
    'StrikerJones_Biker',
    'Jericho_StarCaptain',
    'Jericho',
    'Jericho_Highwayman',
    'Adora',
    'Adora_Fateweaver',
    'Etienne',
    'Bonnie',
    'Etienne_Bee',
];

const mapMap: string[] = [
    'club_jammin',
    'thin_ice',
    'neo_highway',
    'star',
    'sands_of_time',
    'ports',
    'oasis',
    'mayan_map_01',
    'koru',
    'inflection',
    'in_the_wall',
    'glade',
    'garden',
    'docks',
    'dino_graveyard',
    'cobra_command',
    'castle_ruins',
    'building_site_scene',
    'bloontonium_mines',
    'bloon_bot_factory',
    'basalt_columns',
    'banana_depot_scene',
    'off_tide',
    'pirate_cove',
    'precious_space',
    'sun_palace',
    'salmon_pool',
    'island_base',
    'times_up',
    'bloonstone_quarry',
    'up_on_the_roof',
    'splashdown',
    'building_site',
    'le_ruins',
    'mayan',
    'offtide',
    'banana_depot',
    'salmon_ladder',
    'skull_party',
    'bot_factory',
    'lava_canyon',
    'cobra_command_reversed',
    'glade_reversed',
    'oasis_reversed',
    'inflection_reversed',
    'offtide_reversed',
    'park',
];

const resultMap: string[] = ['cancelled', 'draw', 'lobbyDC', 'lose', 'opponentLobbyDC', 'win'];

export function encodeMatch(match: Match) {
    return {
        i: match.id,
        d: encodeMatchResult(match),
        pl: {
            i: extractUserId(match.playerLeft.profileURL),
            t: encodeTowers(match.playerLeft),
        },
        pr: {
            i: extractUserId(match.playerRight.profileURL),
            t: encodeTowers(match.playerRight),
        },
    };
}

function encodeMatchResult(match: Match) {
    return parseInt(
        resultMap.findIndex((e: string) => e === match.playerLeft.result).toString() +
            mapMap
                .findIndex((e: string) => e === match.map)
                .toString()
                .padStart(2, '0') +
            match.endRound.toString().padStart(2, '0') +
            match.duration.toString().padStart(4, '0'),
    );
}

function encodeTowers(player: MatchPlayer) {
    return parseInt(
        heroMap
            .findIndex((e: string) => e === player.hero)
            .toString()
            .padStart(2, '0') +
            towerMap
                .findIndex((e: string) => e === player.towerone)
                .toString()
                .padStart(2, '0') +
            towerMap
                .findIndex((e: string) => e === player.towertwo)
                .toString()
                .padStart(2, '0') +
            towerMap
                .findIndex((e: string) => e === player.towerthree)
                .toString()
                .padStart(2, '0'),
    );
}

export function encodePlayer(player: LeaderboardPlayer): LeaderboardPlayerEncoded {
    const realName = playerNames[extractUserId(player.profile)];
    return {
        i: extractUserId(player.profile),
        ...(realName && { r: realName }),
        n: player.displayName,
        d: +player.currentlyInHoM + player.score.toString(),
    };
}
