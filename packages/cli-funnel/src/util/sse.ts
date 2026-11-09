import { frameSplitter } from "./frames.js";

/** Reads server-sent events from a fetch Response. Stopping early cancels the body, so the download stops too. */
export async function* readSSE(res: Response): AsyncGenerator<{ event?: string; data: string }> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const frames = frameSplitter(/\r?\n\r?\n/, 3, "A server-sent event");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      for (const block of frames.push(value)) {
        let event: string | undefined;
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
