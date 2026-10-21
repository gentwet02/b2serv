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
 * Maps NK renamed over time: old id → current id (castle ruins was "le_ruins" in seasons 33–35,
 * salmon ladder was "salmon_pool", bot factory was "bloon_bot_factory").
 */
export const MAP_RENAMES: Record<string, string> = {
    le_ruins: 'castle_ruins',
    salmon_pool: 'salmon_ladder',
    bloon_bot_factory: 'bot_factory',
};

/** The current id of a map: "salmon_pool" → "salmon_ladder" (the version suffix is kept). */
export function currentMapId(map: string): string {
    const [, base = map, suffix = ''] = /^(.*?)(_reversed)?$/.exec(map) ?? [];
    return (MAP_RENAMES[base] ?? base) + suffix;
}

/**
 * NK has several ids for some maps ("banana_depot" and "banana_depot_scene",
 * "mayan" and "mayan_map_01", "offtide" and "off_tide", renamed maps). They share one key.
 */
export function mapKey(map: string): string {
    return currentMapId(map)
        .toLowerCase()
        .replace(/_(scene|map_01)$/, '')
        .replace(/_/g, '');
}

export type MapVariant = 'classic' | 'reversed';
const REVERSED = /_reversed$/;

/** "oasis_reversed" is the reversed version of "oasis". */
export const mapVariant = (map: string): MapVariant =>
    REVERSED.test(map) ? 'reversed' : 'classic';

/** The key of a map's base, both versions together: "oasis_reversed" → "oasis". */
export const mapBaseKey = (map: string) => mapKey(map.replace(REVERSED, ''));

/**
 * A map filter: "oasis" (both versions), "oasis:classic" or "oasis:reversed".
 * Old keys ("oasisreversed") still work.
 */
export function parseMapFilter(value: string | undefined) {
    const [rawBase = '', rawVariant] = (value ?? '').split(':');
    let base = rawBase.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!base) return undefined;
    let variant: MapVariant | undefined =
        rawVariant === 'classic' || rawVariant === 'reversed' ? rawVariant : undefined;
    if (!variant && base.endsWith('reversed') && base.length > 'reversed'.length) {
        base = base.slice(0, -'reversed'.length);
        variant = 'reversed';
    }
    return { base, variant };
}

/** Does a raw NK map id fit a parsed map filter? */
export const mapFits = (map: string, filter: { base: string; variant?: MapVariant | undefined }) =>
    mapBaseKey(map) === filter.base && (!filter.variant || mapVariant(map) === filter.variant);
