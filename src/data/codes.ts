// /**
//  * Code tables for stored matches: a code is the index in its list.
//  * APPEND ONLY. Never reorder or remove an entry, or every stored match decodes wrong.
//  * The client keeps a copy in src/utils/decode.ts: keep both identical.
//  */

// export const towerMap: readonly string[] = [
//     'Alchemist',
//     'BananaFarm',
//     'BombShooter',
//     'BoomerangMonkey',
//     'DartlingGunner',
//     'DartMonkey',
//     'Druid',
//     'EngineerMonkey',
//     'GlueGunner',
//     'HeliPilot',
//     'IceMonkey',
//     'MonkeyAce',
//     'MonkeyBuccaneer',
//     'MonkeySub',
//     'MonkeyVillage',
//     'MortarMonkey',
//     'NinjaMonkey',
//     'SniperMonkey',
//     'SpikeFactory',
//     'SuperMonkey',
//     'TackShooter',
//     'WizardMonkey',
// ];

// export const heroMap: readonly string[] = [
//     'Agent_Jericho',
//     'Benjamin',
//     'Benjamin_DJ',
//     'Churchill',
//     'Churchill_Sentai',
//     'DartMonkey',
//     'Ezili',
//     'Ezili_SmudgeCat',
//     'Gwendolin',
//     'Gwendolin_Science',
//     'Highwayman_Jericho',
//     'Obyn',
//     'Obyn_Ocean',
//     'PatFusty',
//     'PatFusty_Snowman',
//     'Quincy',
//     'Quincy_Cyber',
//     'StrikerJones',
//     'StrikerJones_Biker',
//     'Jericho_StarCaptain',
//     'Jericho',
//     'Jericho_Highwayman',
//     'Adora',
//     'Adora_Fateweaver',
//     'Etienne',
//     'Bonnie',
//     'Etienne_Bee',
// ];

// export const mapMap: readonly string[] = [
//     'club_jammin',
//     'thin_ice',
//     'neo_highway',
//     'star',
//     'sands_of_time',
//     'ports',
//     'oasis',
//     'mayan_map_01',
//     'koru',
//     'inflection',
//     'in_the_wall',
//     'glade',
//     'garden',
//     'docks',
//     'dino_graveyard',
//     'cobra_command',
//     'castle_ruins',
//     'building_site_scene',
//     'bloontonium_mines',
//     'bloon_bot_factory',
//     'basalt_columns',
//     'banana_depot_scene',
//     'off_tide',
//     'pirate_cove',
//     'precious_space',
//     'sun_palace',
//     'salmon_pool',
//     'island_base',
//     'times_up',
//     'bloonstone_quarry',
//     'up_on_the_roof',
//     'splashdown',
//     'building_site',
//     'le_ruins',
//     'mayan',
//     'offtide',
//     'banana_depot',
//     'salmon_ladder',
//     'skull_party',
//     'bot_factory',
//     'lava_canyon',
//     'cobra_command_reversed',
//     'glade_reversed',
//     'oasis_reversed',
//     'inflection_reversed',
//     'offtide_reversed',
//     'park',
// ];

// export const resultMap: readonly string[] = [
//     'cancelled',
//     'draw',
//     'lobbyDC',
//     'lose',
//     'opponentLobbyDC',
//     'win',
// ];

// /** The other player's result, since only the left player's result is stored. */
// export const opposingResult: Record<string, string> = {
//     win: 'lose',
//     lose: 'win',
//     lobbyDC: 'opponentLobbyDC',
//     opponentLobbyDC: 'lobbyDC',
//     draw: 'draw',
//     cancelled: 'cancelled',
// };

// /**
//  * Hero without its skin: "Quincy_Cyber" → "Quincy", "Agent_Jericho" → "Jericho".
//  * Filtering on a hero includes all of its skins.
//  */
// export function heroBase(hero: string): string {
//     const parts = hero.split('_');
//     return parts.find((part) => heroMap.includes(part)) ?? parts[0];
// }

// export const heroBases: readonly string[] = [...new Set(heroMap.map(heroBase))].sort();

// /** Codes of a base hero and all its skins. */
// export const heroCodesFor = (base: string): number[] =>
//     heroMap.flatMap((hero, code) => (heroBase(hero) === base ? [code] : []));
