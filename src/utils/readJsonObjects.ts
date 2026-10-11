/** Yields each top-level {...} of a JSON array or JSON-lines file, without loading the whole file. */
export async function* readJsonObjects(path: string): AsyncGenerator<unknown> {
    const decoder = new TextDecoder();
    let buf = '';
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for await (const chunk of Bun.file(path).stream()) {
        const from = buf.length;
        buf += decoder.decode(chunk, { stream: true });
        for (let i = from; i < buf.length; i++) {
            const ch = buf[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === '{') {
                if (depth++ === 0) start = i;
            } else if (ch === '}' && --depth === 0) {
                yield JSON.parse(buf.slice(start, i + 1));
                start = -1;
            }
        }
        if (start === -1) buf = '';
        else {
            buf = buf.slice(start);
            start = 0;
        }
    }
}
