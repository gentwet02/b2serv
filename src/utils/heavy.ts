import { HEAVY_MAX_RUNNING, HEAVY_MAX_WAITING, HEAVY_WAIT_MS } from '@/config/limits';
import { logger } from '@/utils/logger';

export class BusyError extends Error {
    constructor() {
        super('Server busy');
        this.name = 'BusyError';
    }
}

/**
 * A gate for the heavy reads (stats, compare, head to head, opponents met): at most
 * HEAVY_MAX_RUNNING computed at once, a few more waiting, the rest turned away with a 503
 * (limits in config/limits.ts).
 */
let running = 0;
const waiting: (() => void)[] = [];

export async function heavy<T>(work: () => Promise<T>): Promise<T> {
    if (running < HEAVY_MAX_RUNNING) {
        running++;
    } else {
        if (waiting.length >= HEAVY_MAX_WAITING) {
            logger.warn(`Heavy read turned away (${running} running, ${waiting.length} waiting)`);
            throw new BusyError();
        }
        // the slot is handed over by the read that ends: `running` doesn't change
        await new Promise<void>((resolve, reject) => {
            function turn() {
                clearTimeout(timer);
                resolve();
            }
            const timer = setTimeout(() => {
                const i = waiting.indexOf(turn);
                if (i >= 0) waiting.splice(i, 1);
                reject(new BusyError());
            }, HEAVY_WAIT_MS);
            waiting.push(turn);
        });
    }
    try {
        return await work();
    } finally {
        const next = waiting.shift();
        if (next) next();
        else running--;
    }
}

/** Busy, or a MongoDB read that ran out of time (MaxTimeMSExpired): worth a retry later. */
export function isOverloaded(error: unknown) {
    if (error instanceof BusyError) return true;
    const e = error as { code?: number; codeName?: string } | null;
    return e?.code === 50 || e?.codeName === 'MaxTimeMSExpired';
}
