export const sseHeaders = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Turns an async iterable into an SSE body. Each item becomes one `data:` line of JSON. */
export function sse(items: AsyncIterable<unknown>, opts: { done?: string } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const it = items[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) {
          if (opts.done) controller.enqueue(enc.encode(`data: ${opts.done}\n\n`));
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(`data: ${JSON.stringify(value)}\n\n`));
      } catch (err) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "error", message: String(err) })}\n\n`));
        controller.close();
      }
    },
    async cancel() {
      await it.return?.();
    },
  });
}
