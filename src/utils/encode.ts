import { playerNames } from '@/config/playerNames';
import { nameTimelineOf } from '@/services/codeBook';
import type { LeaderboardPlayer, LeaderboardPlayerEncoded } from '@/types/leaderboard';
import { extractUserId } from './helpers';

export function encodePlayer(player: LeaderboardPlayer): LeaderboardPlayerEncoded {
    const userId = extractUserId(player.profile);
    const alias = playerNames[userId];
    const timeline = nameTimelineOf(userId);
    const current = timeline.at(-1);
    const old = timeline
        .slice(0, -1)
        .filter((name) => name !== player.displayName && name !== 'Unknown player');
    return {
        i: userId,
        ...(alias && { r: alias }),
        n: player.displayName,
        d: +player.currentlyInHoM + player.score.toString(),
        ...(old.length > 0 && { o: old }),
        ...(current && current !== player.displayName && { c: current }),
    };
}
