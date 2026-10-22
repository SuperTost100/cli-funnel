/** One line of NDJSON: the parsed value, `{ __raw: line }` when it is not JSON, or undefined for a blank line. */
export function parseLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { __raw: trimmed };
  }
}

/**
 * Reads newline-delimited JSON from a fetch Response. Lines that are not JSON come back as `{ __raw }`.
 * Stopping early cancels the body, so the download stops too.
 */
export async function* readNDJSON(res: Response): AsyncGenerator<unknown> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const parsed = parseLine(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (parsed !== undefined) yield parsed;
      }
    }
    const last = parseLine(buffer);
    if (last !== undefined) yield last;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
