import { MongoClient, Db } from 'mongodb';
import { env } from './environment';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectDatabase(): Promise<Db> {
    if (db) {
        return db;
    }

    try {
        console.log('Connecting to MongoDB...');
        client = new MongoClient(env.MONGODB_URI);
        await client.connect();

        db = client.db();
        console.log('Connected to MongoDB successfully');

        return db;
    } catch (error) {
        console.error('Failed to connect to MongoDB:', error);
        throw error;
    }
}

export function getDatabase(): Db {
    if (!db) {
        throw new Error('Database not connected. Call connectDatabase() first.');
    }
    return db;
}

export async function closeDatabase(): Promise<void> {
    if (client) {
        await client.close();
        client = null;
        db = null;
        console.log('Database connection closed');
    }
}

export async function isDatabaseConnected(): Promise<boolean> {
    try {
        if (!db) return false;
        await db.admin().ping();
        return true;
    } catch {
        return false;
    }
}
