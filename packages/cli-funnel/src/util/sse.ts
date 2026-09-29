/** Reads server-sent events from a fetch Response. */
export async function* readSSE(res: Response): AsyncGenerator<{ event?: string; data: string }> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value;
    let i: number;
    while ((i = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i).replace(/^\r?\n\r?\n/, "");
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}
