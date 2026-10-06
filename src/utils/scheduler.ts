import { logger } from '@/utils/logger';

/**
 * setInterval wrapper keyed by name.
 * With `bun --hot`, modules are re-evaluated but timers survive, so a plain
 * setInterval would stack a new timer on every reload. Timers are kept on
 * globalThis and the previous one is cleared before scheduling again.
 */
type Timer = ReturnType<typeof setInterval>;
const g = globalThis as typeof globalThis & { __btdTimers?: Map<string, Timer> };
const timers = (g.__btdTimers ??= new Map<string, Timer>());

export function scheduleEvery(key: string, fn: () => unknown, ms: number) {
    const previous = timers.get(key);
    if (previous) clearInterval(previous);

    const timer = setInterval(() => {
        Promise.resolve()
            .then(fn)
            .catch((error) => logger.error(`[scheduler:${key}] ${error}`));
    }, ms);

    timers.set(key, timer);
    logger.debug(`[scheduler:${key}] every ${ms / 1000}s`);
}
