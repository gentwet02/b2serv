import { GAME_RESULTS, GAME_TYPES, MATCH_SORTS, MAX_RANKED_ROUND } from '@/config/matches';
import { HERO_BASES, TOWERS } from '@/config/towers';
import type { GameResult, GameType, Match, MatchIssue, MatchSort } from '@/types/match';
import type { Hero, Tower } from '@/types/towers';

const heroBases: ReadonlySet<string> = new Set(HERO_BASES);
const towers: ReadonlySet<string> = new Set(TOWERS);
const gameResults: ReadonlySet<string> = new Set(GAME_RESULTS);
const gameTypes: ReadonlySet<string> = new Set(GAME_TYPES);
const matchSorts: ReadonlySet<string> = new Set(MATCH_SORTS);

export function isTower(name: string): name is Tower {
    return towers.has(name);
}

/** A known hero, with or without a skin: "Quincy", "Quincy_Cyber", "Agent_Jericho". */
export function isHero(name: string): name is Hero {
    return name.split('_').some((part) => heroBases.has(part));
}

export function isGameResult(value: string): value is GameResult {
    return gameResults.has(value);
}

export function isGameType(value: string): value is GameType {
    return gameTypes.has(value);
}

export function isRanked(match: Match) {
    return match.gametype === 'Ranked';
}

export function isValidRankedRound(round: number) {
    return round >= 0 && round <= MAX_RANKED_ROUND;
}

export function isMatchSort(value: string): value is MatchSort {
    return matchSorts.has(value);
}

/**
 * The values of an NK match that aren't in our lists, as "tower: NewMonkey".
 * Usually NK added something and config/ needs updating: the match is still good to keep.
 */
export function matchIssues(match: Match): MatchIssue[] {
    const issues: MatchIssue[] = [];
    if (!isGameType(match.gametype)) issues.push(`game type: ${match.gametype}`);
    for (const side of [match.playerLeft, match.playerRight]) {
        if (!isHero(side.hero)) issues.push(`hero: ${side.hero}`);
        for (const tower of [side.towerone, side.towertwo, side.towerthree]) {
            if (!isTower(tower)) issues.push(`tower: ${tower}`);
        }
        if (!isGameResult(side.result)) issues.push(`result: ${side.result}`);
    }
    return issues;
}
