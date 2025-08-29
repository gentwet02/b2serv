import { env } from '@/config/environment';
import { LogLevel } from '@/types/server';

function formatMessage(level: LogLevel, message: string, data?: object): string {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${dataStr}`;
}

export const logger = {
    info: (message: string, data?: object) => {
        console.log(formatMessage('info', message, data));
    },

    warn: (message: string, data?: object) => {
        console.warn(formatMessage('warn', message, data));
    },

    error: (message: string, data?: object) => {
        console.error(formatMessage('error', message, data));
    },

    debug: (message: string, data?: object) => {
        if (env.NODE_ENV === 'development') {
            console.log(formatMessage('debug', message, data));
        }
    },
};
