import { env } from '../config/environment';

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractSeasonId(seasonName: string): number {
    return parseInt(seasonName.replace('Season ', '')) - 1;
}

export function extractUserId(profileUrl: string): string {
    return profileUrl.replace('https://data.ninjakiwi.com/battles2/users/', '');
}

export async function fetchWithRetry(url: string) {
    for (let attempt = 1; attempt <= env.NK_FETCH_RETRIES; attempt++) {
        try {
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error(`Fetch failed for ${url} (attempt ${attempt}):`, error);

            if (attempt < env.NK_FETCH_RETRIES) {
                const timeoutDelay = attempt * 500;
                console.log(`Retrying in ${timeoutDelay}ms...`);
                await delay(timeoutDelay);
            }
        }
    }

    console.error(`Failed to fetch ${url} after ${env.NK_FETCH_RETRIES} attempts`);
    return null;
}
