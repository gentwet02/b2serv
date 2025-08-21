export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface PaginatedResponse<T> {
    data: T[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        pages: number;
    };
}

export interface SystemStatus {
    status: 'running' | 'error';
    database: 'connected' | 'disconnected';
    scheduler: 'running' | 'stopped';
    lastFetch: Date | null;
    nextFetch: Date | null;
    cacheSize: number;
}
