import type { HERO_BASES, TOWERS } from '@/config/towers';

export type HeroBase = (typeof HERO_BASES)[number];
export type Tower = (typeof TOWERS)[number];
/** A hero as NK names it: the base, or the base and a skin ("Quincy_Cyber", "Agent_Jericho"). */
export type Hero =
    | HeroBase
    | `${HeroBase}_${string}`
    | `${string}_${HeroBase}`
    | `${string}_${HeroBase}_${string}`;
