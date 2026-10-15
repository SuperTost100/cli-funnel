import { describe, expect, it } from "vitest";
import { createClient } from "../src/client/index.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sseResponse(text: string) {
  return new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(text)), c.close()) }), {
    headers: { "content-type": "text/event-stream" },
  });
}

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const runInput = { prompt: "hi", selection: { provider: "claude", model: "m", cwd: "/", access: "full" } } as const;

describe("browser client", () => {
  it("reads SSE frames with CRLF line endings and event lines", async () => {
    const frames = 'event: message\r\ndata: {"type":"run","runId":"r1"}\r\n\r\ndata: {"type":"text.delta","text":"hi"}\r\n\r\n';
    const client = createClient({ baseUrl: "/api", fetch: async () => sseResponse(frames) });
    expect(await collect(client.run(runInput))).toEqual([
      { type: "run", runId: "r1" },
      { type: "text.delta", text: "hi" },
    ]);
  });

  it("still reads plain LF frames", async () => {
    const frames = 'data: {"type":"text.delta","text":"a"}\n\ndata: {"type":"text.delta","text":"b"}\n\n';
    const client = createClient({ baseUrl: "/api", fetch: async () => sseResponse(frames) });
    expect(await collect(client.run(runInput))).toHaveLength(2);
  });

  it("shows a nested error message instead of [object Object]", async () => {
    const client = createClient({ baseUrl: "/api", fetch: async () => json({ error: { message: "model not found", type: "invalid_request" } }, 404) });
    await expect(client.providers()).rejects.toThrow("model not found");
  });

  it("shows a nested error message on a failed stream", async () => {
    const client = createClient({ baseUrl: "/api", fetch: async () => json({ error: { message: "nope" } }, 400) });
    await expect(collect(client.run(runInput))).rejects.toThrow("nope");
  });

  it("keeps string errors and falls back to the status", async () => {
    const a = createClient({ baseUrl: "/api", fetch: async () => json({ error: "Unauthorized" }, 401) });
    await expect(a.providers()).rejects.toThrow("Unauthorized");
    const b = createClient({ baseUrl: "/api", fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }) });
    await expect(b.providers()).rejects.toThrow("HTTP 502");
  });

  it("throws when a 200 answer is not JSON", async () => {
    const client = createClient({ baseUrl: "/api", fetch: async () => new Response("<html>Sign in to the Wi-Fi</html>", { headers: { "content-type": "text/html" } }) });
    await expect(client.providers()).rejects.toThrow(/Expected JSON.*HTTP 200/);
  });

  it("strips every trailing slash from baseUrl", async () => {
    const urls: string[] = [];
    const client = createClient({
      baseUrl: "http://host/funnel//",
      fetch: async (url) => (urls.push(String(url)), json([])),
    });
    await client.providers();
    expect(urls).toEqual(["http://host/funnel/providers"]);
  });
});
