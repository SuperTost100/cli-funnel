import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { collect } from "../src/providers/base.js";
import { createOpenAICompatibleProvider, createOpenAICompatibleProviders, parseModelList } from "../src/providers/openai-compatible.js";
import { createHandler } from "../src/server/handler.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

// Recorded from Ollama 0.35.1's /v1 endpoints with smollm2:135m and qwen3:0.6b.
const fx = (n: string) => readFileSync(new URL(`./fixtures/openai-compatible/${n}`, import.meta.url), "utf8");
const IMAGE = { type: "image" as const, mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
const SCHEMA = { schema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] } };
const ID = "openai-compatible:local" as const;
const input = (over: Partial<RunInput> = {}): RunInput => ({
  selection: { provider: ID, model: "smollm2:135m", cwd: "/tmp", access: "full" },
  prompt: "Say hello.",
  ...over,
});
const sse = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/event-stream" } });
const local = (over = {}) => createOpenAICompatibleProvider({ id: "local", name: "Local", baseUrl: "http://box:1/v1/", ...over });

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function stubFetch(respond: (url: string) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return respond(url);
    }),
  );
  return calls;
}

const drain = async (it: AsyncIterable<FunnelEvent>) => {
  const out: FunnelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

describe("openai-compatible setup", () => {
  it("builds one provider per endpoint with a prefixed id", () => {
    const ps = createOpenAICompatibleProviders([
      { id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
      { id: "vllm-gpu", name: "vLLM", baseUrl: "http://gpu:8000/v1", apiKey: "k" },
    ]);
    expect(Object.keys(ps)).toEqual(["openai-compatible:lmstudio", "openai-compatible:vllm-gpu"]);
    expect(ps["openai-compatible:lmstudio"]!.displayName).toBe("LM Studio");
    expect(ps["openai-compatible:lmstudio"]!.capabilities.access).toEqual([]);
  });

  it("rejects bad and repeated ids", () => {
    expect(() => createOpenAICompatibleProviders([{ id: "LM Studio", name: "x", baseUrl: "http://x" }])).toThrow(/lowercase/);
    expect(() =>
      createOpenAICompatibleProviders([
        { id: "a", name: "x", baseUrl: "http://x" },
        { id: "a", name: "y", baseUrl: "http://y" },
      ]),
    ).toThrow(/used twice/);
  });

  it("registers endpoints only when configured", () => {
    expect(Object.keys(createFunnel().providers).some((k) => k.startsWith("openai-compatible:"))).toBe(false);
    expect(createFunnel({ openaiCompatible: [{ id: "local", name: "Local", baseUrl: "http://box:1/v1" }] }).providers[ID]).toBeDefined();
  });

  it("parses /models and passes ids through", () => {
    expect(parseModelList(JSON.parse(fx("models.json")), ID).map((m) => m.id)).toEqual(["qwen3:0.6b", "smollm2:135m"]);
    expect(parseModelList({ object: "list" }, ID)).toEqual([]);
  });
});

describe("openai-compatible provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends max_tokens, schema, images and no auth header without a key", async () => {
    const calls = stubFetch(() => sse(fx("chat.sse")));
    await drain(local().run(input({ system: "S", attachments: [IMAGE], responseSchema: SCHEMA, maxOutputTokens: 12 })));
    const [call] = calls;
    expect(call!.url).toBe("http://box:1/v1/chat/completions");
    expect(call!.headers.authorization).toBeUndefined();
    expect(call!.body.max_tokens).toBe(12);
    expect(call!.body.max_completion_tokens).toBeUndefined();
    expect(call!.body.messages[0]).toEqual({ role: "system", content: "S" });
    expect(call!.body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE.data}` } });
    expect(call!.body.response_format.json_schema).toMatchObject({ name: "response", schema: SCHEMA.schema });
  });

  it("sends the key as a bearer token", async () => {
    const calls = stubFetch(() => sse(fx("chat.sse")));
    await drain(local({ apiKey: "k" }).run(input()));
    expect(calls[0]!.headers.authorization).toBe("Bearer k");
  });

  it("maps a recorded stream with usage and cached tokens", async () => {
    stubFetch(() => sse(fx("chat.sse")));
    const r = await collect(local().run(input()), input());
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.usage).toEqual({ inputTokens: 33, outputTokens: 11, cachedInputTokens: 24, totalTokens: 44 });
    expect(r.finishReason).toBe("stop");
  });

  it("maps the reasoning field to reasoning deltas", async () => {
    stubFetch(() => sse(fx("reasoning.sse")));
    const events = await drain(local().run(input({ selection: { ...input().selection, model: "qwen3:0.6b" } })));
    expect(events.filter((e) => e.type === "reasoning.delta").length).toBeGreaterThan(100);
    expect(events.filter((e) => e.type === "text.delta").map((e) => (e as { text: string }).text).join("")).toContain("4");
  });

  it("maps reasoning_content too", async () => {
    stubFetch(() => sse('data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\ndata: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    const events = await drain(local().run(input()));
    expect(events.filter((e) => e.type === "reasoning.delta")).toEqual([{ type: "reasoning.delta", text: "hmm" }]);
  });

  it("turns an HTTP error into an error with the server's body", async () => {
    stubFetch(() => sse(fx("not-found.json"), 404));
    const events = await drain(local().run(input()));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cli-failed", message: expect.stringContaining("Local 404: ") });
    expect((events.at(-1) as { message: string }).message).toContain("not found");
  });

  it("ends with cancelled when the signal aborts", async () => {
    const ac = new AbortController();
    stubFetch(async () => {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const events = await drain(local().run(input({ signal: ac.signal })));
    expect(events.at(-1)).toEqual({ type: "done", text: "", finishReason: "cancelled" });
  });

  it("lists models from the server", async () => {
    const calls = stubFetch(() => Response.json(JSON.parse(fx("models.json"))));
    expect((await local({ models: ["ignored"] }).models()).map((m) => m.id)).toEqual(["qwen3:0.6b", "smollm2:135m"]);
    expect(calls[0]!.url).toBe("http://box:1/v1/models");
  });

  it("falls back to configured models when /models is missing or empty", async () => {
    stubFetch(() => new Response("404 page not found", { status: 404 }));
    expect((await local({ models: ["my-model"] }).models())).toMatchObject([{ id: "my-model", provider: ID, source: "manifest" }]);
    await expect(local().models()).rejects.toMatchObject({ message: expect.stringContaining("Pass models") });
    stubFetch(() => Response.json({ object: "list", data: [] }));
    expect((await local({ models: ["my-model"] }).models()).map((m) => m.id)).toEqual(["my-model"]);
  });

  it("treats any HTTP answer as installed, and 401 as signed out", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    expect(await local().detect()).toMatchObject({ installed: true, path: "http://box:1/v1" });
    expect(await local().authStatus()).toEqual({ loggedIn: true, method: "No key" });
    stubFetch(() => new Response("", { status: 401 }));
    expect(await local({ apiKey: "bad" }).authStatus()).toMatchObject({ loggedIn: false, detail: expect.stringContaining("Check its apiKey") });
    await expect(local({ apiKey: "bad" }).models()).rejects.toMatchObject({ code: "not-logged-in" });
  });

  it("reports an unreachable server with the reason", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await local().detect()).toMatchObject({ installed: false, detail: "Local is not reachable at http://box:1/v1." });
    const funnel = createFunnel({ openaiCompatible: [{ id: "local", name: "Local", baseUrl: "http://box:1/v1" }] });
    await expect(funnel.run(input())).rejects.toMatchObject({ code: "not-installed" });
  });

  it("works through the /v1 endpoint of the cli-funnel server", async () => {
    stubFetch((url) => (url.endsWith("/models") ? Response.json(JSON.parse(fx("models.json"))) : sse(fx("chat.sse"))));
    const funnel = createFunnel({ openaiCompatible: [{ id: "local", name: "Local", baseUrl: "http://box:1/v1" }] });
    const handler = createHandler(funnel, { openai: { cwd: "/tmp", access: "full" }, fsRoots: ["/tmp"] });
    const res = await handler(
      new Request("http://funnel/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${ID}/smollm2:135m`, messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]!.message.content.length).toBeGreaterThan(0);
  });
});

const LIVE_URL = process.env.CLI_FUNNEL_OPENAI_COMPAT_URL;
const LIVE_MODEL = process.env.CLI_FUNNEL_OPENAI_COMPAT_MODEL;

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1" || !LIVE_URL || !LIVE_MODEL)("openai-compatible live", () => {
  it("lists models, answers, resumes and returns structured output", async () => {
    const funnel = createFunnel({ openaiCompatible: [{ id: "live", name: "Live", baseUrl: LIVE_URL!, apiKey: process.env.CLI_FUNNEL_OPENAI_COMPAT_KEY }] });
    const selection = { provider: "openai-compatible:live" as const, model: LIVE_MODEL!, cwd: "/tmp", access: "full" as const };
    expect((await funnel.models(selection.provider)).some((m) => m.id === LIVE_MODEL)).toBe(true);
    const a = await funnel.run({ selection, prompt: "Remember the word pineapple. Reply only: noted", maxOutputTokens: 40 });
    expect(a.usage?.totalTokens).toBeGreaterThan(0);
    const b = await funnel.run({ selection, prompt: "Which word did I ask you to remember?", sessionId: a.sessionId, maxOutputTokens: 40 });
    expect(b.text.length).toBeGreaterThan(0);
    const c = await funnel.run({ selection, prompt: "Give a=1 as JSON.", responseSchema: SCHEMA, maxOutputTokens: 40 });
    expect(c.structured).toMatchObject({ a: expect.any(Number) });
  }, 120_000);
});
