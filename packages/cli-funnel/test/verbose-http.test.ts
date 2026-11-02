import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiProviders } from "../src/providers/api.js";
import { createOllamaProvider } from "../src/providers/ollama/index.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { FunnelEvent, Provider, ProviderId, RunInput } from "../src/types.js";

// The bodies are the hand-written vendor fixtures, with one extra chunk in front that echoes the credentials.
const fx = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");
const KEY = "sk-verbose-secret-0123456789";
const GATEWAY = "gw-secret-value-0123456789";
const echo = { echo: `key ${KEY}, header ${GATEWAY}` };

/** Answers every call with `body`, plus a header that echoes the key and a cookie that must stay out of `raw`. */
function stubFetch(body: string, contentType: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: {
            "content-type": contentType,
            "x-echo": KEY,
            "set-cookie": "session=abcdefgh",
            "x-session-token": "tok-abcdefgh",
            "x-refresh-token": "tok-abcdefgh",
            "x-ratelimit-remaining-tokens": "9000",
            "x-request-id": "req_1",
          },
        }),
    ),
  );
}

const sse = (fixture: string) => `data: ${JSON.stringify(echo)}\n\n${fx(fixture)}`;
// Ollama takes no extra headers, so only its key is a secret there.
const ndjson = (fixture: string) => `${JSON.stringify({ echo: `key ${KEY}` })}\n${fx(fixture)}`;

const run = async (p: Provider, provider: ProviderId, model: string, verbose?: boolean): Promise<FunnelEvent[]> => {
  const input: RunInput = { selection: { provider, model, cwd: "/tmp", access: "full" }, prompt: "Say hello.", verbose };
  const out: FunnelEvent[] = [];
  for await (const e of p.run(input)) out.push(e);
  return out;
};

const api = createApiProviders({}, {
  anthropic: { key: KEY, headers: { "x-gateway-token": GATEWAY } },
  openai: { key: KEY, headers: { "x-gateway-token": GATEWAY } },
  gemini: { key: KEY, headers: { "x-gateway-token": GATEWAY } },
});
const compat = (mode?: "chat" | "responses") =>
  createOpenAICompatibleProvider({ id: "gw", name: "Gateway", baseUrl: "http://gw:1/v1", apiKey: KEY, headers: { "x-gateway-token": GATEWAY }, mode });

const cases: { name: string; provider: () => Provider; id: ProviderId; model: string; body: string; type: string; chunks: number }[] = [
  { name: "Anthropic API", provider: () => api["anthropic-api"], id: "anthropic-api", model: "claude-haiku-4-5", body: sse("anthropic-api/thinking.sse"), type: "text/event-stream", chunks: 0 },
  { name: "OpenAI API, Chat Completions", provider: () => api["openai-api"], id: "openai-api", model: "gpt-4.1", body: sse("openai-api/stream.sse"), type: "text/event-stream", chunks: 0 },
  { name: "OpenAI API, Responses", provider: () => api["openai-api"], id: "openai-api", model: "gpt-5-pro", body: sse("openai-api/responses.sse"), type: "text/event-stream", chunks: 0 },
  { name: "Gemini API", provider: () => api["gemini-api"], id: "gemini-api", model: "gemini-3-pro-preview", body: sse("gemini-api/stream.sse"), type: "text/event-stream", chunks: 0 },
  { name: "Ollama", provider: () => createOllamaProvider({ baseUrl: "http://box:1", apiKey: KEY }), id: "ollama", model: "smollm2:135m", body: ndjson("ollama/chat.ndjson"), type: "application/x-ndjson", chunks: 0 },
  { name: "OpenAI-compatible, chat", provider: () => compat(), id: "openai-compatible:gw", model: "m", body: sse("openai-compatible/chat.sse"), type: "text/event-stream", chunks: 0 },
  { name: "OpenAI-compatible, responses", provider: () => compat("responses"), id: "openai-compatible:gw", model: "m", body: sse("openai-api/responses.sse"), type: "text/event-stream", chunks: 0 },
];
for (const c of cases) c.chunks = c.type === "text/event-stream" ? c.body.split(/\n\n/).filter((b) => /^data:/m.test(b)).length : c.body.split("\n").filter(Boolean).length;

describe("verbose on HTTP providers", () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const c of cases) {
    it(`${c.name}: emits the response and every chunk, with the key and headers masked`, async () => {
      stubFetch(c.body, c.type);
      const events = await run(c.provider(), c.id, c.model, true);
      const raw = events.filter((e) => e.type === "raw");
      expect(raw.every((e) => e.provider === c.id)).toBe(true);
      const [response, ...chunks] = raw;
      expect(response).toMatchObject({ source: "response", data: { status: 200, headers: { "x-echo": "[redacted]", "x-request-id": "req_1", "x-ratelimit-remaining-tokens": "9000" } } });
      const shown = (response!.data as { headers: Record<string, string> }).headers;
      for (const name of ["set-cookie", "x-session-token", "x-refresh-token"]) expect(shown).not.toHaveProperty(name);
      // The run stops reading at the vendor's end marker, so a chunk after it may not show.
      expect(chunks.every((e) => e.source === "http")).toBe(true);
      expect(chunks.length).toBeGreaterThanOrEqual(c.chunks - 1);
      expect(chunks[0]).toMatchObject({ data: { echo: c.id === "ollama" ? "key [redacted]" : "key [redacted], header [redacted]" } });
      expect(JSON.stringify(events)).not.toMatch(/0123456789|abcdefgh/);
      expect(events.at(-1)?.type).toBe("done");
      // Each raw chunk comes before the events parsed from it.
      expect(events.findIndex((e) => e.type === "raw")).toBe(events.findIndex((e) => e.type !== "session" && e.type !== "retry"));
    });

    it(`${c.name}: emits nothing new without verbose`, async () => {
      stubFetch(c.body, c.type);
      const off = await run(c.provider(), c.id, c.model);
      expect(off.some((e) => e.type === "raw")).toBe(false);
      stubFetch(c.body, c.type);
      const on = await run(c.provider(), c.id, c.model, true);
      // History providers make up a session id per run, so compare without it.
      const plain = (events: FunnelEvent[]) => events.filter((e) => e.type !== "raw" && e.type !== "session");
      expect(plain(on)).toEqual(plain(off));
    });
  }

  it("sends the status and headers of a response that is retried", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (n++ === 0 ? new Response("busy", { status: 503 }) : new Response(sse("anthropic-api/thinking.sse"), { status: 200, headers: { "content-type": "text/event-stream" } }))),
    );
    const p = createApiProviders({}, { anthropic: { key: KEY, retryDelayMs: 1 } })["anthropic-api"];
    const events = await run(p, "anthropic-api", "claude-haiku-4-5", true);
    expect(events.filter((e) => e.type === "raw" && e.source === "response").map((e) => (e as { data: { status: number } }).data.status)).toEqual([503, 200]);
    expect(events.findIndex((e) => e.type === "retry")).toBeGreaterThan(0);
  });
});
