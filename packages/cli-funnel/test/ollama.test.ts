import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect } from "../src/providers/base.js";
import { createOllamaProvider } from "../src/providers/ollama/index.js";
import { mapChatLine, mapPullLine, normalizeBaseUrl, parseTags } from "../src/providers/ollama/parser.js";
import { createFunnel } from "../src/funnel.js";
import { createHandler } from "../src/server/handler.js";
import { createClient } from "../src/client/index.js";
import type { FunnelEvent, PullEvent, RunInput } from "../src/types.js";

// Recorded from Ollama 0.35.1 with smollm2:135m and qwen3:0.6b.
const fx = (n: string) => readFileSync(new URL(`./fixtures/ollama/${n}`, import.meta.url), "utf8");
const lines = (n: string) => fx(n).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const IMAGE = { type: "image" as const, mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
const SCHEMA = { schema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] } };
const input = (over: Partial<RunInput> = {}): RunInput => ({
  selection: { provider: "ollama", model: "smollm2:135m", cwd: "/tmp", access: "full" },
  prompt: "Say hello.",
  ...over,
});
const ndjson = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/x-ndjson" } });

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

describe("ollama parser", () => {
  it("lists models with the server id and a short digest", () => {
    const models = parseTags(JSON.parse(fx("tags.json")));
    expect(models.map((m) => m.id)).toEqual(["qwen3:0.6b", "smollm2:135m"]);
    expect(models[1]).toMatchObject({ provider: "ollama", name: "smollm2:135m (9077fe9d)", efforts: [], fast: false });
  });

  it("drops models that cannot chat", () => {
    const models = parseTags({ models: [{ name: "nomic-embed-text:v1.5", digest: "abc", capabilities: ["embedding"] }, { name: "old:1b" }] });
    expect(models.map((m) => m.id)).toEqual(["old:1b"]);
  });

  it("maps a chat stream to deltas, usage and done", () => {
    const events = lines("chat.ndjson").flatMap(mapChatLine);
    const text = events.filter((e) => e.type === "text.delta").map((e) => (e as { text: string }).text).join("");
    expect(text.length).toBeGreaterThan(0);
    expect(events.at(-2)).toEqual({ type: "usage", usage: { inputTokens: 23, outputTokens: 8, cachedInputTokens: 0, totalTokens: 31 } });
    expect(events.at(-1)).toEqual({ type: "done", text: "", finishReason: "stop" });
  });

  it("maps thinking to reasoning deltas", () => {
    const events = lines("thinking.ndjson").flatMap(mapChatLine);
    expect(events.filter((e) => e.type === "reasoning.delta").length).toBeGreaterThan(10);
    expect(events.some((e) => e.type === "text.delta")).toBe(true);
  });

  it("maps an error line", () => {
    expect(mapChatLine({ error: "model 'nope:1b' not found" })).toEqual([{ type: "error", message: "model 'nope:1b' not found", code: "cli-failed" }]);
  });

  it("normalizes base URLs the way Ollama reads OLLAMA_HOST", () => {
    expect(normalizeBaseUrl("127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(normalizeBaseUrl("0.0.0.0")).toBe("http://127.0.0.1:11434");
    expect(normalizeBaseUrl("gpu-box:8080")).toBe("http://gpu-box:8080");
    expect(normalizeBaseUrl("https://ollama.example.com/")).toBe("https://ollama.example.com");
    expect(normalizeBaseUrl("http://localhost:11434/")).toBe("http://localhost:11434");
  });
});

describe("ollama provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends system, images, schema, output limit and the bearer key", async () => {
    const calls = stubFetch(() => ndjson(fx("chat.ndjson")));
    const p = createOllamaProvider({ baseUrl: "http://box:1", apiKey: "k" });
    await drain(p.run(input({ system: "S", attachments: [IMAGE], responseSchema: SCHEMA, maxOutputTokens: 20 })));
    const [call] = calls;
    expect(call!.url).toBe("http://box:1/api/chat");
    expect(call!.headers.authorization).toBe("Bearer k");
    expect(call!.body).toEqual({
      model: "smollm2:135m",
      messages: [{ role: "system", content: "S" }, { role: "user", content: "Say hello.", images: [IMAGE.data] }],
      stream: true,
      format: SCHEMA.schema,
      options: { num_predict: 20 },
    });
  });

  it("keeps history across turns and never stores the system message", async () => {
    const calls = stubFetch(() => ndjson(fx("chat.ndjson")));
    const p = createOllamaProvider({ baseUrl: "http://box:1" });
    const first = await collect(p.run(input({ system: "S" })), input());
    await drain(p.run(input({ prompt: "Again.", sessionId: first.sessionId })));
    expect(calls[1]!.body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(calls[1]!.body.messages[1].content).toBe(first.text);
  });

  it("turns a 404 into an error with Ollama's message", async () => {
    stubFetch(() => ndjson(fx("not-found.json"), 404));
    const events = await drain(createOllamaProvider({ baseUrl: "http://box:1" }).run(input({ selection: { ...input().selection, model: "nope:1b" } })));
    expect(events.at(-1)).toEqual({ type: "error", message: "Ollama 404: model 'nope:1b' not found", code: "cli-failed" });
  });

  it("reports a stream that ends early", async () => {
    stubFetch(() => ndjson(fx("chat.ndjson").split("\n").slice(0, 3).join("\n")));
    const events = await drain(createOllamaProvider({ baseUrl: "http://box:1" }).run(input()));
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("before the answer finished") });
  });

  it("ends with cancelled when the signal aborts", async () => {
    const ac = new AbortController();
    stubFetch(async () => {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const events = await drain(createOllamaProvider({ baseUrl: "http://box:1" }).run(input({ signal: ac.signal })));
    expect(events.at(-1)).toEqual({ type: "done", text: "", finishReason: "cancelled" });
  });

  it("detects a running server and its version", async () => {
    stubFetch(() => Response.json(JSON.parse(fx("version.json"))));
    const i = await createOllamaProvider({ baseUrl: "http://box:1" }).detect();
    expect(i).toMatchObject({ installed: true, version: "0.35.1", withinTestedRange: true, path: "http://box:1" });
  });

  it("reports a server that does not answer as not installed, with the reason", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const p = createOllamaProvider({ baseUrl: "http://box:1" });
    const i = await p.detect();
    expect(i.installed).toBe(false);
    expect(i.detail).toContain("not running at http://box:1");
    expect((await p.authStatus()).loggedIn).toBe(false);
  });

  it("treats a 401 as installed but signed out", async () => {
    stubFetch(() => new Response("", { status: 401 }));
    const p = createOllamaProvider({ baseUrl: "http://box:1", apiKey: "wrong" });
    expect((await p.detect()).installed).toBe(true);
    expect(await p.authStatus()).toMatchObject({ loggedIn: false, detail: expect.stringContaining("refused") });
  });

  it("falls back to OLLAMA_HOST", async () => {
    const old = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = "0.0.0.0:9999";
    try {
      const calls = stubFetch(() => Response.json({ models: [] }));
      await createOllamaProvider().models();
      expect(calls[0]!.url).toBe("http://127.0.0.1:9999/api/tags");
    } finally {
      if (old === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = old;
    }
  });

  it("fails a run up front with the reason when no server answers", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const funnel = createFunnel({ ollama: { baseUrl: "http://box:1" } });
    await expect(funnel.run(input())).rejects.toMatchObject({ code: "not-installed", message: expect.stringContaining("not running at http://box:1") });
  });
});

describe("ollama pull and delete", () => {
  afterEach(() => vi.unstubAllGlobals());

  const collectPull = async (it: AsyncIterable<PullEvent>) => {
    const out: PullEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  it("maps pull lines", () => {
    const events = lines("pull.ndjson").map(mapPullLine);
    expect(events[0]).toEqual({ type: "progress", status: "pulling manifest" });
    expect(events.find((e) => e?.type === "progress" && e.completed)).toMatchObject({ total: 45949216, digest: expect.stringMatching(/^sha256:/) });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(mapPullLine({ error: "boom" })).toEqual({ type: "error", message: "boom" });
  });

  it("streams a pull and stops at success", async () => {
    const calls = stubFetch(() => ndjson(fx("pull.ndjson")));
    const events = await collectPull(createOllamaProvider({ baseUrl: "http://box:1" }).pullModel!("all-minilm:22m"));
    expect(calls[0]).toMatchObject({ url: "http://box:1/api/pull", body: { model: "all-minilm:22m", stream: true } });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.filter((e) => e.type === "progress").length).toBeGreaterThan(5);
  });

  it("reports a pull error sent inside a 200 stream", async () => {
    stubFetch(() => ndjson(fx("pull-error.ndjson")));
    const events = await collectPull(createOllamaProvider({ baseUrl: "http://box:1" }).pullModel!("no-such-model-cf:1b"));
    expect(events.at(-1)).toEqual({ type: "error", message: "pull model manifest: file does not exist" });
  });

  it("deletes a model and explains a missing one", async () => {
    const calls = stubFetch((url) => (calls.length > 1 ? ndjson(fx("delete-not-found.json"), 404) : new Response("", { status: 200 })));
    const p = createOllamaProvider({ baseUrl: "http://box:1" });
    await p.deleteModel!("all-minilm:22m");
    expect(calls[0]).toMatchObject({ url: "http://box:1/api/delete", body: { model: "all-minilm:22m" } });
    await expect(p.deleteModel!("all-minilm:22m")).rejects.toMatchObject({ code: "invalid-selection" });
  });

  it("is refused on providers that cannot manage models", () => {
    const funnel = createFunnel();
    expect(funnel.providers.ollama.capabilities.manageModels).toBe(true);
    expect(funnel.providers.claude.capabilities.manageModels).toBeFalsy();
    expect(() => funnel.pullModel("claude", "x")).toThrow(/cannot pull models/);
  });

  it("streams a pull through the HTTP handler and the client", async () => {
    const funnel = createFunnel({ ollama: { baseUrl: "http://box:1" } });
    const handler = createHandler(funnel);
    stubFetch(() => ndjson(fx("pull.ndjson")));
    const client = createClient({ baseUrl: "http://funnel", fetch: (url, init) => handler(new Request(url as string, init)) });
    const events = await collectPull(client.pullModel("ollama", "all-minilm:22m"));
    expect(events.at(-1)).toEqual({ type: "done" });
    const refused = await handler(new Request("http://funnel/providers/claude/models/pull", { method: "POST", body: JSON.stringify({ name: "x" }) }));
    expect(refused.status).toBe(409);
  });
});

const LIVE_URL = process.env.CLI_FUNNEL_OLLAMA_URL ?? process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
const LIVE_MODEL = process.env.CLI_FUNNEL_OLLAMA_MODEL;

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1" || !LIVE_MODEL)("ollama live", () => {
  it("lists models, answers, resumes and returns structured output", async () => {
    const funnel = createFunnel({ ollama: { baseUrl: LIVE_URL } });
    const selection = { ...input().selection, model: LIVE_MODEL! };
    expect((await funnel.models("ollama")).some((m) => m.id === LIVE_MODEL)).toBe(true);
    const a = await funnel.run({ selection, prompt: "Remember the word pineapple. Reply only: noted", maxOutputTokens: 40 });
    expect(a.usage?.totalTokens).toBeGreaterThan(0);
    const b = await funnel.run({ selection, prompt: "Which word did I ask you to remember?", sessionId: a.sessionId, maxOutputTokens: 40 });
    expect(b.text.length).toBeGreaterThan(0);
    const c = await funnel.run({ selection, prompt: "Give a=1 as JSON.", responseSchema: SCHEMA, maxOutputTokens: 40 });
    expect(c.structured).toMatchObject({ a: expect.any(Number) });
  }, 120_000);

  // Downloads and deletes a model on the server. Point CLI_FUNNEL_OLLAMA_URL at a throwaway server.
  it.skipIf(!process.env.CLI_FUNNEL_OLLAMA_PULL)("pulls and deletes a model", async () => {
    const funnel = createFunnel({ ollama: { baseUrl: LIVE_URL } });
    const name = process.env.CLI_FUNNEL_OLLAMA_PULL!;
    const events: PullEvent[] = [];
    for await (const e of funnel.pullModel("ollama", name)) events.push(e);
    expect(events.at(-1)).toEqual({ type: "done" });
    await funnel.deleteModel("ollama", name);
    await expect(funnel.deleteModel("ollama", name)).rejects.toMatchObject({ code: "invalid-selection" });
  }, 600_000);
});
