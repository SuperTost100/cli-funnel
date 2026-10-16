import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApiProviders } from "../src/providers/api.js";
import { createOllamaProvider } from "../src/providers/ollama/index.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { joinUrl } from "../src/util/url.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

describe("joinUrl", () => {
  it("adds the path before the base's query string", () => {
    expect(joinUrl("https://x.example/openai?api-version=2024-10-21", "/chat/completions")).toBe("https://x.example/openai/chat/completions?api-version=2024-10-21");
    expect(joinUrl("https://x.example/v1/?key=a%2Fb", "/models?limit=10")).toBe("https://x.example/v1/models?key=a%2Fb&limit=10");
  });

  it("joins a base without a query as before", () => {
    expect(joinUrl("https://x.example/v1/", "/models?limit=10")).toBe("https://x.example/v1/models?limit=10");
    expect(joinUrl("/api/funnel", "/providers")).toBe("/api/funnel/providers");
  });
});

describe("providers with a query string on baseUrl", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  /** Records each request path and answers every one with an empty, finished stream. */
  async function recorder(): Promise<{ base: string; seen: string[] }> {
    const seen: string[] = [];
    server = createServer((req, res) => {
      seen.push(req.url!);
      if (req.url!.includes("/api/chat")) {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        return res.end('{"message":{"content":"hi"},"done":true,"done_reason":"stop"}\n');
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
  }

  const drain = async (it: AsyncIterable<FunnelEvent>) => {
    const out: FunnelEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };
  const input = (provider: string): RunInput => ({ selection: { provider, model: "m" } as RunInput["selection"], prompt: "hi" });

  it("keeps the query at the end for OpenAI-compatible servers", async () => {
    const { base, seen } = await recorder();
    const p = createOpenAICompatibleProvider({ id: "gw", name: "Gateway", baseUrl: `${base}/v1?token=abc` });
    expect((await drain(p.run(input("openai-compatible:gw")))).at(-1)).toMatchObject({ type: "done" });
    expect(seen).toEqual(["/v1/chat/completions?token=abc"]);
  });

  it("keeps the query at the end for the OpenAI API", async () => {
    const { base, seen } = await recorder();
    const p = createApiProviders({ openai: "k" }, { openai: { baseUrl: `${base}/openai?api-version=2024-10-21` } })["openai-api"];
    expect((await drain(p.run(input("openai-api")))).at(-1)).toMatchObject({ type: "done" });
    expect(seen).toEqual(["/openai/chat/completions?api-version=2024-10-21"]);
  });

  it("keeps the query at the end for Ollama", async () => {
    const { base, seen } = await recorder();
    const p = createOllamaProvider({ baseUrl: `${base}/?tenant=a` });
    expect((await drain(p.run(input("ollama")))).at(-1)).toMatchObject({ type: "done" });
    expect(seen).toEqual(["/api/chat?tenant=a"]);
  });
});
