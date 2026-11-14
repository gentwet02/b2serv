import { nameTimelineOf } from '@/services/codeBook';
import type { LeaderboardPlayer, LeaderboardPlayerEncoded } from '@/types/leaderboard';
import { aliasOf, isOldName, isSameName, latestSpellings, tagOf } from '@/utils/players';
import { extractUserId } from './helpers';

export function encodePlayer(player: LeaderboardPlayer): LeaderboardPlayerEncoded {
    const userId = extractUserId(player.profile);
    const alias = aliasOf(userId);
    const tag = tagOf(userId);
    const timeline = nameTimelineOf(userId);
    const current = timeline.at(-1);
    // newest first, like the profile's names
    const old = latestSpellings(timeline.slice(0, -1).reverse()).filter((name) =>
        isOldName(name, player.displayName),
    );
    return {
        i: userId,
        ...(alias && { r: alias }),
        ...(tag && { t: tag }),
        n: player.displayName,
        d: +player.currentlyInHoM + player.score.toString(),
        ...(old.length > 0 && { o: old }),
        ...(current && !isSameName(current, player.displayName) && { c: current }),
    };
}
