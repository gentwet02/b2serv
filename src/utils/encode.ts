import { playerNames } from '@/config/playerNames';
import { otherNamesOf } from '@/services/codeBook';
import type { LeaderboardPlayer, LeaderboardPlayerEncoded } from '@/types/leaderboard';
import { extractUserId } from './helpers';

export function encodePlayer(player: LeaderboardPlayer): LeaderboardPlayerEncoded {
    const userId = extractUserId(player.profile);
    const alias = playerNames[userId];
    const others = otherNamesOf(userId, player.displayName);
    return {
        i: userId,
        ...(alias && { r: alias }),
        n: player.displayName,
        d: +player.currentlyInHoM + player.score.toString(),
        ...(others.length > 0 && { o: others }),
    };
}
