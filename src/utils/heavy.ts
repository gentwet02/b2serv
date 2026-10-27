import { logger } from '@/utils/logger';

/**
 * A gate for the heavy reads (stats, compare, head to head, opponents met): at most
 * MAX_RUNNING computed at once, a few more waiting, the rest turned away with a 503.
 */
const MAX_RUNNING = 2;
const MAX_WAITING = 6;
/** how long a read may wait for its turn */
const WAIT_MS = 20_000;

/** Every MongoDB read of the heavy paths stops after this (server side too). */
export const HEAVY_QUERY_MAX_MS = 30_000;

export class BusyError extends Error {
    constructor() {
        super('Server busy');
        this.name = 'BusyError';
    }
}

let running = 0;
const waiting: (() => void)[] = [];

export async function heavy<T>(work: () => Promise<T>): Promise<T> {
    if (running < MAX_RUNNING) {
        running++;
    } else {
        if (waiting.length >= MAX_WAITING) {
            logger.warn(`Heavy read turned away (${running} running, ${waiting.length} waiting)`);
            throw new BusyError();
        }
        // the slot is handed over by the read that ends: `running` doesn't change
        await new Promise<void>((resolve, reject) => {
            const turn = () => {
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(() => {
                const i = waiting.indexOf(turn);
                if (i >= 0) waiting.splice(i, 1);
                reject(new BusyError());
            }, WAIT_MS);
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

export const BUSY_MESSAGE = 'The server is busy, try again in a moment.';
