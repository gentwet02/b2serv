import { playerNames } from '@/data/playerNames';
import type { LeaderboardPlayer, LeaderboardPlayerEncoded } from '@/types/leaderboard';
import { extractUserId } from './helpers';

export function encodePlayer(player: LeaderboardPlayer): LeaderboardPlayerEncoded {
    const alias = playerNames[extractUserId(player.profile)];
    return {
        i: extractUserId(player.profile),
        ...(alias && { r: alias }),
        n: player.displayName,
        d: +player.currentlyInHoM + player.score.toString(),
    };
}
