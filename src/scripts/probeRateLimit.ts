/**
 * Finds NK's rate limits, including several stacked ones (per second, per minute, per hour,
 * per endpoint). Prints the headers of one answer, then sends requests at a steady pace.
 * On each 429 it records how many requests went out in the last 1s / 10s / 60s / 10min,
 * checks whether the other endpoints are blocked too, waits it out, halves the pace and goes on.
 *
 * Every request goes to a JSON-lines log (logs/, git-ignored); the terminal only shows a line
 * a minute, the 429s and the summary (also on Ctrl+C).
 *
 *   bun run src/scripts/probeRateLimit.ts [--rps 8] [--minutes 20] [--wait 60]
 *       [--urls <NK url>,<NK url>] [--log <file>]
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { NK_API } from '@/config/nk';
import { delay } from '@/utils/helpers';

// headers that usually carry limits, plus the CDN ones that tell where the answer came from
const LIMIT_HEADER = /rate|limit|retry|quota|remaining|reset|cache|age|cf-|x-amz|via|server/i;
const WINDOWS_S = [1, 10, 60, 600];
const MIN_RPS = 0.1;
// change on every answer: left out when looking for headers that really changed
const VOLATILE_HEADER = /^(cf-ray|age|date)$/i;

interface Hit {
    n: number;
    url: string;
    atS: number;
    rps: number;
    windows: Record<string, number>;
    retryAfter: string | null;
    othersBlocked: string[];
}

function arg(name: string, fallback: string) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function limitHeaders(headers: Headers) {
    return Object.fromEntries([...headers].filter(([key]) => LIMIT_HEADER.test(key)));
}

function stableHeaders(headers: Headers) {
    const all = limitHeaders(headers);
    return JSON.stringify(Object.entries(all).filter(([key]) => !VOLATILE_HEADER.test(key)));
}

function log(entry: object) {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function get(url: string) {
    return fetch(url, { headers: { Accept: 'application/json' } });
}

function short(url: string) {
    return url.replace(NK_API.SEASONS, '/homs');
}

const urls = arg('urls', `${NK_API.SEASONS},${NK_API.LEADERBOARD(47)}`).split(',');
const endAt = Date.now() + Number(arg('minutes', '20')) * 60_000;
const defaultWaitMs = Number(arg('wait', '60')) * 1000;
let rps = Number(arg('rps', '8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = arg('log', `logs/probeRateLimit-${stamp}.jsonl`);
mkdirSync('logs', { recursive: true });
log({ type: 'start', at: new Date().toISOString(), urls, rps, argv: process.argv.slice(2) });
console.log(`Logging every request to ${logPath}`);

console.log(`\n1) One request to each endpoint\n`);
for (const url of urls) {
    const res = await get(url);
    await res.text();
    console.log(`${short(url)} → HTTP ${res.status}`);
    for (const [key, value] of res.headers) console.log(`  ${key}: ${value}`);
    const headers = Object.fromEntries(res.headers);
    log({ type: 'first', url: short(url), status: res.status, headers });
}

console.log(`\n2) Steady stream from ${rps} requests/s, rotating over ${urls.length} endpoints\n`);
const start = Date.now();
const sentAt: number[] = [];
const hits: Hit[] = [];
let lastSeen = '';
let ok = 0;
let nextReportAt = start + 60_000;

function printSummary() {
    const minutes = ((Date.now() - start) / 60_000).toFixed(1);
    console.log(`\nDone after ${minutes} min: ${ok} ok, ${hits.length} × 429. Log: ${logPath}`);
    for (const h of hits) {
        console.log(
            `  ${h.atS}s at ${h.rps}/s on ${h.url}:`,
            h.windows,
            `retry-after ${h.retryAfter ?? '-'}`,
            `others blocked: ${h.othersBlocked.join(', ') || 'none'}`,
        );
    }
    log({ type: 'summary', at: new Date().toISOString(), ok, hits });
}

process.on('SIGINT', () => {
    printSummary();
    process.exit(0);
});

for (let n = 1; Date.now() < endAt && rps >= MIN_RPS; n++) {
    const url = urls[n % urls.length]!;
    const t = Date.now();
    sentAt.push(t);
    const res = await get(url);
    const body = await res.text();
    const ms = Date.now() - t;
    const atS = Math.round((t - start) / 1000);
    const windows = Object.fromEntries(
        WINDOWS_S.map((w) => [`${w}s`, sentAt.filter((s) => t - s < w * 1000).length]),
    );
    const at = new Date(t).toISOString();
    const entry = { n, at, atS, url: short(url), status: res.status, ms, rps };
    log({ ...entry, windows, headers: limitHeaders(res.headers) });

    if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        // a limiter per endpoint leaves the other endpoints answering
        const othersBlocked: string[] = [];
        for (const other of urls.filter((u) => u !== url)) {
            const check = await get(other);
            await check.text();
            sentAt.push(Date.now());
            if (check.status === 429) othersBlocked.push(short(other));
        }
        hits.push({ n, url: short(url), atS, rps, windows, retryAfter, othersBlocked });
        log({
            type: '429',
            ...entry,
            windows,
            othersBlocked,
            headers: Object.fromEntries(res.headers),
            body: body.slice(0, 300),
        });
        console.log(`\n429 #${hits.length}: request ${n} (${short(url)}) at ${atS}s, ${rps}/s`);
        console.log(`  sent in the last`, windows);
        console.log(`  other endpoints blocked too: ${othersBlocked.join(', ') || 'none'}`);
        console.log(`  headers:`, Object.fromEntries(res.headers));
        console.log(`  body: ${body.slice(0, 300)}`);

        const waitMs =
            retryAfter && Number.isFinite(+retryAfter) ? +retryAfter * 1000 : defaultWaitMs;
        // "retry-after: 0" is the end of the previous block, not a new limit: same pace
        if (waitMs > 0) rps /= 2;
        console.log(`  waiting ${waitMs / 1000}s, then going on at ${rps}/s\n`);
        await delay(Math.max(waitMs, 2_000));
        continue;
    }
    if (res.status === 200) ok++;
    else console.log(`#${n} at ${atS}s (${short(url)}): HTTP ${res.status}`);
    // only print headers that really change, so a countdown (X-RateLimit-Remaining) shows up
    const seen = stableHeaders(res.headers);
    if (seen !== lastSeen) {
        console.log(`#${n} at ${atS}s, headers now:`, seen);
        lastSeen = seen;
    }
    if (Date.now() >= nextReportAt) {
        const minute = Math.round(atS / 60);
        console.log(`${minute} min: ${ok} ok, ${hits.length} × 429, ${windows['60s']} in last 60s`);
        nextReportAt += 60_000;
    }
    await delay(Math.max(0, 1000 / rps - (Date.now() - t)));
}

printSummary();
process.exit(0);
