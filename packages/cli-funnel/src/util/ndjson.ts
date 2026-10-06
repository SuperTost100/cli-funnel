/** Reads newline-delimited JSON from a fetch Response. Lines that are not JSON come back as `{ __raw }`. */
export async function* readNDJSON(res: Response): AsyncGenerator<unknown> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const parse = (line: string) => {
    try {
      return JSON.parse(line);
    } catch {
      return { __raw: line };
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) yield parse(line);
    }
  }
  if (buffer.trim()) yield parse(buffer.trim());
}
