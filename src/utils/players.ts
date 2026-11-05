import { playerNames } from '@/config/playerNames';
import { PLAYER_TAGS } from '@/config/tags';
import type { PlayerTag } from '@/types/player';

const TAGS = Object.keys(PLAYER_TAGS) as PlayerTag[];

/** The player's tag, when they are on one of the lists in `config/tags.ts`. */
export function tagOf(userId: string): PlayerTag | undefined {
    return TAGS.find((tag) => Object.hasOwn(PLAYER_TAGS[tag], userId));
}

/** The player's alias: `playerNames` first, then the name their tag list gives them. */
export function aliasOf(userId: string): string | undefined {
    if (Object.hasOwn(playerNames, userId)) return playerNames[userId];
    const tag = tagOf(userId);
    return tag && PLAYER_TAGS[tag][userId];
}
