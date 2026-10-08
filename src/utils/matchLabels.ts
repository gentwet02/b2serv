import { HERO_BASES } from '@/data/towers';

/**
 * Grouping rules for filters. Stored matches keep Ninja Kiwi's raw names;
 * these only decide which raw names belong together.
 */

/** "Quincy_Cyber" → "Quincy", "Agent_Jericho" → "Jericho". */
export function heroBase(hero: string, known: Iterable<string> = HERO_BASES): string {
    const bases = new Set(known);
    const parts = hero.split('_');
    return parts.find((part) => bases.has(part)) ?? parts[0];
}

/**
 * NK has several ids for some maps ("banana_depot" and "banana_depot_scene",
 * "mayan" and "mayan_map_01", "offtide" and "off_tide"). They share one key.
 */
export function mapKey(map: string): string {
    return map
        .toLowerCase()
        .replace(/_(scene|map_01)$/, '')
        .replace(/_/g, '');
}
