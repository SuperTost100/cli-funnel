import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { anthropicBody, createApiProviders, type ApiConfig } from "../src/providers/api.js";
import { collect } from "../src/providers/base.js";
import { retryAfterMs } from "../src/providers/http.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { FunnelEvent, ProviderId, RunInput } from "../src/types.js";

// Fixtures follow the shapes in the vendor API references. They were written by hand, not recorded.
const fx = (dir: string, n: string) => readFileSync(new URL(`./fixtures/${dir}/${n}`, import.meta.url), "utf8");
const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const input = (provider: ProviderId, model: string, over: Partial<RunInput> = {}): RunInput => ({
  selection: { provider, model, cwd: "/tmp", access: "full" },
  prompt: "Say hello.",
  ...over,
});
const failure = (status: number, headers: Record<string, string> = {}) => new Response(`{"error":{"message":"status ${status}"}}`, { status, headers });

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** Answers each call in turn with the next response, and repeats the last one. */
function stubFetch(...responses: (Response | ((url: string) => Response))[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
      if (typeof next === "function") return next(url);
      // A fresh response for each call. Cancelling one half of a clone would wait on the other half.
      return new Response(await next.clone().text(), { status: next.status, headers: next.headers });
    }),
  );
  return calls;
}

const drain = async (it: AsyncIterable<FunnelEvent>) => {
  const out: FunnelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const FAST = { retryDelayMs: 1 };
const providers = (config: ApiConfig = {}, keys = { anthropic: "k", openai: "k", gemini: "k" }) => createApiProviders(keys, config);

describe("base URL and headers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends each vendor's requests to its configured base URL", async () => {
    const calls = stubFetch((url) => (url.includes("/models") && !url.includes("generateContent") ? Response.json({ data: [], models: [] }) : sse("")));
    const p = providers({
      anthropic: { baseUrl: "https://gw.example.com/anthropic/" },
      openai: { baseUrl: "https://gw.example.com/openai/v1" },
      gemini: { baseUrl: "https://gw.example.com/gemini/v1beta" },
    });
    await p["anthropic-api"].models();
    await drain(p["anthropic-api"].run(input("anthropic-api", "claude-sonnet-5-5")));
    await p["openai-api"].models();
    await drain(p["openai-api"].run(input("openai-api", "gpt-5.5")));
    await p["gemini-api"].models();
    await drain(p["gemini-api"].run(input("gemini-api", "gemini-3.8-flash")));
    expect(calls.map((c) => c.url)).toEqual([
      "https://gw.example.com/anthropic/v1/models?limit=1000",
      "https://gw.example.com/anthropic/v1/messages",
      "https://gw.example.com/openai/v1/models",
      "https://gw.example.com/openai/v1/chat/completions",
      "https://gw.example.com/gemini/v1beta/models?pageSize=1000",
      "https://gw.example.com/gemini/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    ]);
  });

  it("keeps the vendor URLs by default", async () => {
    const calls = stubFetch(sse(""));
    await drain(providers()["anthropic-api"].run(input("anthropic-api", "claude-sonnet-5-5")));
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("adds headers, and lets one replace a default whatever its case", async () => {
    const calls = stubFetch(sse(""));
    const p = providers({ anthropic: { headers: { "X-API-Key": "gateway-token", "x-team": "docs" } } });
    await drain(p["anthropic-api"].run(input("anthropic-api", "claude-sonnet-5-5")));
    expect(calls[0]!.headers).toEqual({
      "x-api-key": "gateway-token",
      "anthropic-version": "2023-06-01",
      "x-team": "docs",
      "content-type": "application/json",
    });
  });

  it("sends the extra headers on OpenAI and Gemini calls too", async () => {
    const calls = stubFetch(sse(""));
    const p = providers({ openai: { headers: { "x-team": "docs" } }, gemini: { headers: { "x-team": "docs" } } });
    await drain(p["openai-api"].run(input("openai-api", "gpt-5.5")));
    await drain(p["gemini-api"].run(input("gemini-api", "gemini-3.8-flash")));
    expect(calls[0]!.headers).toEqual({ authorization: "Bearer k", "x-team": "docs", "content-type": "application/json" });
    expect(calls[1]!.headers).toEqual({ "x-goog-api-key": "k", "x-team": "docs", "content-type": "application/json" });
  });

  it("runs without a key when the headers carry the auth", async () => {
    const old = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const calls = stubFetch(sse(""));
      const p = createApiProviders({}, { openai: { headers: { authorization: "Bearer from-gateway" } } })["openai-api"];
      expect(await p.authStatus()).toMatchObject({ loggedIn: true, method: "Headers" });
      await drain(p.run(input("openai-api", "gpt-5.5")));
      expect(calls[0]!.headers.authorization).toBe("Bearer from-gateway");
      const bare = createApiProviders()["openai-api"];
      expect((await bare.authStatus()).loggedIn).toBe(false);
    } finally {
      if (old !== undefined) process.env.OPENAI_API_KEY = old;
    }
  });

  it("takes the key from api, ahead of apiKeys", async () => {
    const calls = stubFetch(sse(""));
    const p = providers({ gemini: { key: "from-api" } }, { anthropic: "k", openai: "k", gemini: "from-apiKeys" });
    await drain(p["gemini-api"].run(input("gemini-api", "gemini-3.8-flash")));
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("from-api");
  });

  it("builds the providers from createFunnel({ api }) alone", async () => {
    const calls = stubFetch(sse(fx("openai-api", "stream.sse")));
    const funnel = createFunnel({ api: { openai: { key: "k", baseUrl: "https://gw.example.com/v1" } }, allowUnlistedModels: true });
    const r = await funnel.run(input("openai-api", "gpt-5.5"));
    expect(r.text).toBe("Hello.");
    expect(calls[0]!.url).toBe("https://gw.example.com/v1/chat/completions");
  });

  it("sends headers on an OpenAI-compatible endpoint", async () => {
    const calls = stubFetch(sse(fx("openai-compatible", "chat.sse")));
    const p = createOpenAICompatibleProvider({ id: "gw", name: "Gateway", baseUrl: "http://box:1/v1", apiKey: "k", headers: { "x-team": "docs" } });
    await drain(p.run(input("openai-compatible:gw", "m")));
    expect(calls[0]!.headers).toEqual({ authorization: "Bearer k", "x-team": "docs", "content-type": "application/json" });
  });
});

describe("retries", () => {
  afterEach(() => vi.unstubAllGlobals());
  const run = (config: ApiConfig, over: Partial<RunInput> = {}) =>
    drain(providers(config)["openai-api"].run(input("openai-api", "gpt-5.5", over)));

  it("sends the request again after a 429 and reports the retry", async () => {
    const calls = stubFetch(failure(429), sse(fx("openai-api", "stream.sse")));
    const events = await run({ openai: FAST });
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.type === "retry")).toEqual([{ type: "retry", attempt: 1, status: 429, delayMs: 1 }]);
    expect(events.filter((e) => e.type === "text.delta")).toEqual([{ type: "text.delta", text: "Hello." }]);
  });

  it("counts retries in the run result", async () => {
    stubFetch(failure(503), failure(529), sse(fx("openai-api", "stream.sse")));
    const funnel = createFunnel({ api: { openai: { key: "k", ...FAST } }, allowUnlistedModels: true });
    const r = await funnel.run(input("openai-api", "gpt-5.5"));
    expect(r.retries).toBe(2);
    expect(r.text).toBe("Hello.");
  });

  it("leaves retries out of the result when none happened", async () => {
    stubFetch(sse(fx("openai-api", "stream.sse")));
    const r = await collect(providers()["openai-api"].run(input("openai-api", "gpt-5.5")), input("openai-api", "gpt-5.5"));
    expect(r.retries).toBeUndefined();
  });

  it("gives up after three attempts and reports the last error", async () => {
    const calls = stubFetch(failure(500));
    const events = await run({ openai: FAST });
    expect(calls).toHaveLength(3);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("OpenAI API 500") });
  });

  it("does not retry when retries is 0", async () => {
    const calls = stubFetch(failure(429));
    const events = await run({ openai: { retries: 0, ...FAST } });
    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("keeps keys and header values out of the error after the last retry", async () => {
    stubFetch(() => new Response("bad key sk-live-1234567890 and token gw-secret-value", { status: 503 }));
    const p = providers({ openai: { ...FAST, headers: { "x-gateway-token": "gw-secret-value" } } }, { anthropic: "k", openai: "sk-live-1234567890", gemini: "k" });
    const events = await drain(p["openai-api"].run(input("openai-api", "gpt-5.5")));
    const last = events.at(-1) as { type: string; message: string };
    expect(last.type).toBe("error");
    expect(last.message).toContain("503");
    expect(last.message).not.toContain("sk-live-1234567890");
    expect(last.message).not.toContain("gw-secret-value");
  });

  it("does not retry client errors", async () => {
    const calls = stubFetch(failure(400), failure(400));
    await run({ openai: FAST });
    expect(calls).toHaveLength(1);
  });

  it("waits as long as Retry-After says, not as long as the backoff", async () => {
    // A backoff of ten seconds would time the test out, so a pass shows the header won.
    const calls = stubFetch(failure(429, { "retry-after": "0" }), sse(fx("openai-api", "stream.sse")));
    const events = await run({ openai: { retryDelayMs: 10_000 } });
    expect(calls).toHaveLength(2);
    expect(events.find((e) => e.type === "retry")).toMatchObject({ delayMs: 0 });
  });

  it("does not wait for a Retry-After beyond the limit", async () => {
    const calls = stubFetch(failure(429, { "retry-after": "120" }), sse(fx("openai-api", "stream.sse")));
    const events = await run({ openai: FAST });
    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("429") });
  });

  it("doubles the wait on each retry", async () => {
    stubFetch(failure(500), failure(500), sse(fx("openai-api", "stream.sse")));
    const events = await run({ openai: { retryDelayMs: 2 } });
    expect(events.filter((e) => e.type === "retry").map((e) => (e as { delayMs: number }).delayMs)).toEqual([2, 4]);
  });

  it("never retries once output has started", async () => {
    // A 200 with text and then an error is past the first byte. Sending it again would repeat text.
    const calls = stubFetch(
      sse('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"error":{"message":"overloaded"}}\n\n'),
      sse(fx("openai-api", "stream.sse")),
    );
    const events = await run({ openai: FAST });
    expect(calls).toHaveLength(1);
    expect(events.some((e) => e.type === "retry")).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["session", "text.delta", "error"]);
  });

  it("retries Anthropic and Gemini calls", async () => {
    const a = stubFetch(failure(529), sse(fx("anthropic-api", "thinking.sse")));
    const events = await drain(providers({ anthropic: FAST })["anthropic-api"].run(input("anthropic-api", "claude-sonnet-5-5")));
    expect(a).toHaveLength(2);
    expect(events.filter((e) => e.type === "text.delta")).toHaveLength(2);
    const g = stubFetch(failure(503), sse(fx("gemini-api", "stream.sse")));
    await drain(providers({ gemini: FAST })["gemini-api"].run(input("gemini-api", "gemini-3.8-flash")));
    expect(g).toHaveLength(2);
  });

  it("retries an OpenAI-compatible endpoint, with its own retries setting", async () => {
    const calls = stubFetch(failure(503));
    const p = createOpenAICompatibleProvider({ id: "gw", name: "Gateway", baseUrl: "http://box:1/v1", retries: 1 });
    await drain(p.run(input("openai-compatible:gw", "m")));
    expect(calls).toHaveLength(2);
  });

  it("stops waiting when the run is cancelled", async () => {
    stubFetch(failure(429, { "retry-after": "20" }));
    const ctl = new AbortController();
    const events = drain(providers({ openai: FAST })["openai-api"].run(input("openai-api", "gpt-5.5", { signal: ctl.signal })));
    setTimeout(() => ctl.abort(), 20);
    expect((await events).at(-1)).toEqual({ type: "done", text: "", finishReason: "cancelled" });
  });

  it("reads Retry-After as seconds or as a date", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs("0")).toBe(0);
    expect(retryAfterMs("Thu, 01 Jan 2026 00:00:10 GMT", Date.parse("2026-01-01T00:00:00Z"))).toBe(10_000);
    expect(retryAfterMs("Thu, 01 Jan 2026 00:00:00 GMT", Date.parse("2026-01-01T00:00:10Z"))).toBe(0);
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });
});

describe("prompt caching", () => {
  afterEach(() => vi.unstubAllGlobals());
  const model = "claude-sonnet-5-5";
  const CACHE = { type: "ephemeral" };

  it("marks the system prompt and the newest turn", () => {
    const body = anthropicBody(input("anthropic-api", model, { system: "Be terse.", cache: true }), [
      { role: "user", content: "First." },
      { role: "assistant", content: "Reply." },
      { role: "user", content: "Second." },
    ]) as { system: unknown; messages: { content: unknown }[] };
    expect(body.system).toEqual([{ type: "text", text: "Be terse.", cache_control: CACHE }]);
    expect(body.messages.map((m) => m.content)).toEqual(["First.", "Reply.", [{ type: "text", text: "Second.", cache_control: CACHE }]]);
  });

  it("marks the last block of a turn with images", () => {
    const content = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }, { type: "text", text: "What is this?" }];
    const body = anthropicBody(input("anthropic-api", model, { cache: true }), [{ role: "user", content }]) as { messages: { content: unknown[] }[] };
    expect(body.messages[0]!.content).toEqual([content[0], { type: "text", text: "What is this?", cache_control: CACHE }]);
    expect(content[1]).not.toHaveProperty("cache_control");
  });

  it("sends no cache_control unless asked", () => {
    const body = anthropicBody(input("anthropic-api", model, { system: "Be terse." }), [{ role: "user", content: "Hi." }]);
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("keeps the stored history free of cache markers across turns", async () => {
    const calls = stubFetch(sse(fx("anthropic-api", "thinking.sse")));
    const p = providers()["anthropic-api"];
    const first = await collect(p.run(input("anthropic-api", model, { cache: true })), input("anthropic-api", model));
    await drain(p.run(input("anthropic-api", model, { prompt: "Again.", sessionId: first.sessionId, cache: true })));
    expect(calls[1]!.body.messages).toEqual([
      { role: "user", content: "Say hello." },
      { role: "assistant", content: "Hello there." },
      { role: "user", content: [{ type: "text", text: "Again.", cache_control: CACHE }] },
    ]);
  });

  it("passes a Gemini cached content name through", async () => {
    const calls = stubFetch(sse(""));
    await drain(providers()["gemini-api"].run(input("gemini-api", "gemini-3.8-flash", { cachedContent: "cachedContents/abc123" })));
    expect(calls[0]!.body.cachedContent).toBe("cachedContents/abc123");
    await drain(providers()["gemini-api"].run(input("gemini-api", "gemini-3.8-flash")));
    expect(calls[1]!.body).not.toHaveProperty("cachedContent");
  });

  it("declares cache support on Anthropic and Gemini only", () => {
    const p = providers();
    expect(p["anthropic-api"].capabilities.cache).toBe(true);
    expect(p["gemini-api"].capabilities.cache).toBe(true);
    expect(p["openai-api"].capabilities.cache).toBe(false);
  });

  it("refuses cache options on a provider without them", async () => {
    const funnel = createFunnel({ apiKeys: { openai: "k" }, allowUnlistedModels: true });
    await expect(funnel.run(input("openai-api", "gpt-5.5", { cache: true }))).rejects.toMatchObject({ code: "unsupported" });
  });
});
