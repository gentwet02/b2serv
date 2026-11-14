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

const squash = (name: string) => name.replace(/\s+/g, '').toLowerCase();

/**
 * Whether two names are the same once case and spacing are ignored: NK's display name and the
 * one we recorded can differ only that way ("Zhou" / "ZHOU"), which isn't a rename to show.
 * The client's `getAlias` compares an alias with the name the same way.
 */
export function isSameName(a: string, b: string) {
    return squash(a) === squash(b);
}

/** A name the player went by before: not the current one (see isSameName), nor the placeholder. */
export function isOldName(name: string, currentName: string) {
    return !isSameName(name, currentName) && name !== 'Unknown player';
}

/**
 * One spelling per name, newest first in, newest first out: of the names that differ only in
 * case or spacing (see isSameName), the most recent one stays.
 */
export function latestSpellings(newestFirst: string[]) {
    const seen = new Set<string>();
    return newestFirst.filter((name) => {
        const key = squash(name);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
