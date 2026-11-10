/**
 * bun run src/scripts/rebuildClanMembers.ts
 * Builds `clan_members` again from every stored profile (services/clanMembers.ts). The server
 * keeps it up to date by itself: only needed after profiles were changed by hand, and the
 * running server sees the result at its next start.
 */
import { rebuildClanMembers } from '@/services/clanMembers';
import connectDB from '@/services/database';

await connectDB();
const { clans, players } = await rebuildClanMembers();
console.log(`${players} players in ${clans} clans`);
process.exit(0);
