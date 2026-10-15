import { mkdtempSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createApiProviders, openaiChatModel } from "../src/providers/api.js";
import { fileHistory, memoryHistory } from "../src/providers/history.js";
import { createOllamaProvider } from "../src/providers/ollama/index.js";
import { parseTags } from "../src/providers/ollama/parser.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { redact } from "../src/util/redact.js";
import type { FunnelEvent, ProviderId, RunInput } from "../src/types.js";

const drain = async (events: AsyncIterable<FunnelEvent>) => {
  const out: FunnelEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};
const sse = (lines: (object | string)[], status = 200) =>
  new Response(lines.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), { status, headers: { "content-type": "text/event-stream" } });
const ndjson = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
const input = (provider: ProviderId, over: Partial<RunInput> = {}): RunInput => ({
  selection: { provider, model: "m", cwd: "/tmp", access: "full" },
  prompt: "Hi.",
  ...over,
});
const api = () => createApiProviders({ anthropic: "ak", openai: "ok", gemini: "gk" });

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: any;
}
function stubFetch(respond: (url: string, call: number, signal?: AbortSignal | null) => Response | Promise<Response>): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      sent.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return respond(url, sent.length - 1, init.signal);
    }),
  );
  return sent;
}

const anthropicTurn = (text: string, extra: object[] = [], usage: object = { input_tokens: 3 }) => [
  { type: "message_start", message: { usage } },
  { type: "content_block_delta", delta: { type: "text_delta", text } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ...extra,
  { type: "message_stop" },
];

afterEach(() => vi.unstubAllGlobals());

describe("truncated streams (#35)", () => {
  const cut = {
    "anthropic-api": [{ type: "message_start", message: { usage: { input_tokens: 3 } } }, { type: "content_block_delta", delta: { type: "text_delta", text: "Par" } }],
    "openai-api": [{ choices: [{ delta: { content: "Par" } }] }],
    "gemini-api": [{ candidates: [{ content: { parts: [{ text: "Par" }] } }] }],
  } as const;

  for (const provider of ["anthropic-api", "openai-api", "gemini-api"] as const) {
    it(`${provider} reports stream-truncated and does not store the partial answer`, async () => {
      const sent = stubFetch((_u, call) => (call === 0 ? sse([...cut[provider]]) : sse([])));
      const first = await drain(api()[provider].run(input(provider, { sessionId: "s" })));
      expect(first.at(-1)).toMatchObject({ type: "error", code: "stream-truncated" });
      expect(first.some((e) => e.type === "done")).toBe(false);
      await drain(api()[provider].run(input(provider, { sessionId: "s", prompt: "Again." })));
      const history = provider === "gemini-api" ? sent[1]!.body.contents : sent[1]!.body.messages;
      expect(history).toHaveLength(1);
    });
  }

  it("ollama reports stream-truncated when no done line arrives", async () => {
    stubFetch(() => ndjson('{"message":{"content":"Par"}}\n'));
    const events = await drain(createOllamaProvider({ baseUrl: "http://box:1" }).run(input("ollama")));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "stream-truncated" });
  });

  it("chat completions accept a finish_reason without [DONE]", async () => {
    stubFetch(() => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]));
    const events = await drain(api()["openai-api"].run(input("openai-api")));
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
  });
});

describe("stream handling (#36)", () => {
  it("ollama returns at the done line even when the connection stays open", async () => {
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"message":{"content":"ok"},"done":true,"done_reason":"stop","eval_count":1}\n'));
            },
          }),
        ),
    );
    const events = await drain(createOllamaProvider({ baseUrl: "http://box:1" }).run(input("ollama")));
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
  });

  it("ollama shows a line that is not JSON when no done line arrives", async () => {
    stubFetch(() => ndjson("<html>502 Bad Gateway</html>\n"));
    const events = await drain(createOllamaProvider({ baseUrl: "http://box:1" }).run(input("ollama")));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((events.at(-1) as { message: string }).message).toContain("<html>502 Bad Gateway</html>");
  });

  it("ollama ignores a stray non-JSON line when the run finishes", async () => {
    stubFetch(() => ndjson('garbage\n{"message":{"content":"ok"},"done":true}\n'));
    const events = await drain(createOllamaProvider({ baseUrl: "http://box:1" }).run(input("ollama")));
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("an abort while the error body is read ends the run as cancelled", async () => {
    const ac = new AbortController();
    stubFetch((_u, _c, signal) => {
      const body = new ReadableStream({
        start(c) {
          signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
      });
      setTimeout(() => ac.abort(), 10);
      return new Response(body, { status: 502 });
    });
    const p = createOpenAICompatibleProvider({ id: "local", name: "Local", baseUrl: "http://box:1/v1" });
    const events = await drain(p.run(input("openai-compatible:local", { signal: ac.signal })));
    expect(events.at(-1)).toEqual({ type: "done", text: "", finishReason: "cancelled" });
  });
});

describe("usage, finish reasons and strict schemas (#37)", () => {
  it("counts cache reads and writes as input on the Anthropic API", async () => {
    stubFetch(() => sse(anthropicTurn("ok", [], { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 })));
    const events = await drain(api()["anthropic-api"].run(input("anthropic-api")));
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 18, outputTokens: 1, cachedInputTokens: 10, cacheCreationInputTokens: 5, totalTokens: 19 },
    });
  });

  it("maps Anthropic refusal and a full context window", async () => {
    for (const [reason, expected] of [["refusal", "denied"], ["model_context_window_exceeded", "length"]] as const) {
      stubFetch(() => sse([{ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 1 } }, { type: "message_stop" }]));
      expect((await drain(api()["anthropic-api"].run(input("anthropic-api")))).at(-1)).toMatchObject({ finishReason: expected });
    }
  });

  it("maps a Chat Completions refusal to denied and reports reasoning tokens", async () => {
    stubFetch(() =>
      sse([
        { choices: [{ delta: { refusal: "No." }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 2, completion_tokens: 9, total_tokens: 11, completion_tokens_details: { reasoning_tokens: 7 } } },
        "[DONE]",
      ]),
    );
    const events = await drain(api()["openai-api"].run(input("openai-api")));
    expect(events.at(-1)).toMatchObject({ finishReason: "denied" });
    expect(events.find((e) => e.type === "usage")).toMatchObject({ usage: { reasoningTokens: 7, totalTokens: 11 } });
    stubFetch(() => sse([{ choices: [{ delta: { content: "x" }, finish_reason: "refusal" }] }, "[DONE]"]));
    expect((await drain(api()["openai-api"].run(input("openai-api")))).at(-1)).toMatchObject({ finishReason: "denied" });
  });

  it("turns Gemini MALFORMED_FUNCTION_CALL and OTHER into errors", async () => {
    for (const reason of ["MALFORMED_FUNCTION_CALL", "OTHER"]) {
      stubFetch(() => sse([{ candidates: [{ content: { parts: [{ text: "a" }] }, finishReason: reason }] }]));
      const events = await drain(api()["gemini-api"].run(input("gemini-api")));
      expect(events.at(-1)).toMatchObject({ type: "error" });
      expect(events.some((e) => e.type === "done")).toBe(false);
    }
  });

  it("sends strict only from the OpenAI API, not to other servers", async () => {
    const schema = { schema: { type: "object", properties: {}, additionalProperties: false } };
    const sent = stubFetch(() => sse([{ choices: [{ delta: { content: "{}" }, finish_reason: "stop" }] }]));
    await drain(api()["openai-api"].run(input("openai-api", { responseSchema: schema })));
    await drain(createOpenAICompatibleProvider({ id: "local", name: "Local", baseUrl: "http://box:1/v1" }).run(input("openai-compatible:local", { responseSchema: schema })));
    expect(sent[0]!.body.response_format.json_schema.strict).toBe(true);
    expect(sent[1]!.body.response_format.json_schema).not.toHaveProperty("strict");
  });
});

describe("history store (#38)", () => {
  const funnel = (history?: ReturnType<typeof memoryHistory>) => createFunnel({ apiKeys: { anthropic: "ak", gemini: "gk" }, allowUnlistedModels: true, history });

  it("does not share sessions between funnels", async () => {
    const sent = stubFetch(() => sse(anthropicTurn("Hello.")));
    await funnel().run(input("anthropic-api", { sessionId: "same" }));
    await funnel().run(input("anthropic-api", { sessionId: "same", prompt: "Again." }));
    expect(sent[1]!.body.messages).toEqual([{ role: "user", content: "Again." }]);
  });

  it("keeps a session apart per provider", async () => {
    const f = funnel();
    const sent = stubFetch((url) =>
      url.includes("generativelanguage") ? sse([{ candidates: [{ content: { parts: [{ text: "Seen." }] }, finishReason: "STOP" }] }]) : sse(anthropicTurn("Hello.")),
    );
    await f.run(input("gemini-api", { sessionId: "s", attachments: [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }] }));
    await f.run(input("anthropic-api", { sessionId: "s", prompt: "Again." }));
    expect(JSON.stringify(sent[1]!.body)).not.toContain("inlineData");
    expect(sent[1]!.body.messages).toEqual([{ role: "user", content: "Again." }]);
  });

  it("runs overlapping turns on one session one after another", async () => {
    const sent = stubFetch(async (_u, call) => {
      await new Promise((r) => setTimeout(r, call === 0 ? 30 : 0));
      return sse(anthropicTurn(`Answer ${call + 1}.`));
    });
    const f = funnel();
    const a = f.run(input("anthropic-api", { sessionId: "s", prompt: "One." }));
    const b = f.run(input("anthropic-api", { sessionId: "s", prompt: "Two." }));
    await Promise.all([a, b]);
    await f.run(input("anthropic-api", { sessionId: "s", prompt: "Three." }));
    expect(sent[2]!.body.messages.map((m: { content: string }) => m.content)).toEqual(["One.", "Answer 1.", "Two.", "Answer 2.", "Three."]);
  });

  it("stores the turn when the consumer stops at done", async () => {
    const history = memoryHistory();
    stubFetch(() => sse(anthropicTurn("Hello.")));
    for await (const e of funnel(history).stream(input("anthropic-api", { sessionId: "s" }))) if (e.type === "done") break;
    expect(await history.get("anthropic-api:s")).toHaveLength(2);
  });

  it("an aborted wait does not block the session", async () => {
    stubFetch(async (_u, call) => {
      if (call === 0) await new Promise((r) => setTimeout(r, 30));
      return sse(anthropicTurn("ok"));
    });
    const f = funnel();
    const first = f.run(input("anthropic-api", { sessionId: "s" }));
    const ac = new AbortController();
    const waiting = drain(f.stream(input("anthropic-api", { sessionId: "s", signal: ac.signal })));
    ac.abort();
    expect((await waiting).at(-1)).toMatchObject({ finishReason: "cancelled" });
    await first;
    expect((await drain(f.stream(input("anthropic-api", { sessionId: "s" })))).at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
  });

  it("fileHistory leaves files younger than the grace period and breaks ties by name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-history-"));
    const young = fileHistory(dir, 1, 60_000);
    for (const id of ["a", "b", "c"]) await young.set(id, [id]);
    expect(readdirSync(dir)).toHaveLength(3);
    const old = fileHistory(dir, 1, 0);
    await old.set("d", ["d"]);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(await old.get("d")).toEqual(["d"]);
  });
});

describe("Gemini thought signatures (#39)", () => {
  it("sends the stored parts, signature included, on the next turn", async () => {
    const sent = stubFetch(() =>
      sse([
        { candidates: [{ content: { parts: [{ text: "Thinking.", thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: "Hel" }] } }] },
        { candidates: [{ content: { parts: [{ text: "lo.", thoughtSignature: "SIG" }] }, finishReason: "STOP" }] },
      ]),
    );
    const first = await drain(api()["gemini-api"].run(input("gemini-api")));
    const sessionId = (first[0] as { sessionId: string }).sessionId;
    await drain(api()["gemini-api"].run(input("gemini-api", { sessionId, prompt: "Again." })));
    expect(sent[1]!.body.contents).toEqual([
      { role: "user", parts: [{ text: "Hi." }] },
      { role: "model", parts: [{ text: "Hel" }, { text: "lo.", thoughtSignature: "SIG" }] },
      { role: "user", parts: [{ text: "Again." }] },
    ]);
  });
});

describe("model lists (#40)", () => {
  it("keeps chat models and fine-tunes, drops Responses-only models and aliases", () => {
    const keep = ["gpt-5", "gpt-4o-mini", "o3", "o4-mini", "ft:gpt-4o-mini-2024-07-18:acme::abc123"];
    const drop = ["gpt-5-pro", "gpt-5-codex", "gpt-5.1-codex-max", "o3-pro", "o3-deep-research", "chatgpt-4o-latest", "gpt-4o-latest", "gpt-4o-audio-preview", "text-embedding-3-small", "dall-e-3"];
    expect(keep.filter(openaiChatModel)).toEqual(keep);
    expect(drop.filter(openaiChatModel)).toEqual([]);
  });

  it("lists OpenAI models through the filter", async () => {
    stubFetch(() => Response.json({ data: [{ id: "gpt-5-pro" }, { id: "gpt-5" }, { id: "ft:gpt-4o-mini:acme::1" }] }));
    expect((await api()["openai-api"].models()).map((m) => m.id)).toEqual(["ft:gpt-4o-mini:acme::1", "gpt-5"]);
  });

  it("follows Anthropic pages", async () => {
    const sent = stubFetch((url) =>
      url.includes("after_id=b")
        ? Response.json({ data: [{ id: "c" }], has_more: false, last_id: "c" })
        : Response.json({ data: [{ id: "a" }, { id: "b" }], has_more: true, last_id: "b" }),
    );
    expect((await api()["anthropic-api"].models()).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(sent).toHaveLength(2);
  });

  it("drops embedding models from an Ollama server that lists no capabilities", () => {
    const models = parseTags({
      models: [
        { name: "llama3.2:latest", details: { family: "llama" } },
        { name: "nomic-embed-text:latest", details: { family: "nomic-bert" } },
        { name: "all-minilm:latest", details: { family: "bert" } },
        { name: "mxbai-embed-large:latest" },
        { name: "bge-m3:latest" },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["llama3.2:latest"]);
  });
});

describe("secrets in errors (#41)", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it("redacts keys, tokens and query strings", () => {
    expect(redact("GET https://gw.example/v1?api_key=abc123 failed", ["abc123"])).toBe("GET https://gw.example/v1 failed");
    expect(redact("echo: Bearer sk-live-1234567890abcdef")).toBe("echo: Bearer [redacted]");
    expect(redact("key AIzaSyA1234567890abcdefghij and sk-proj-abcdefgh12345")).toBe("key [redacted] and [redacted]");
    expect(redact("my-secret-key in the body", ["my-secret-key"])).toBe("[redacted] in the body");
    expect(redact("https://user:pw@host/path#frag")).toBe("https://host/path");
  });

  it("keeps the key out of an error body that echoes the request headers", async () => {
    let port = 0;
    server = createServer((req, res) => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end(`bad request to ${req.url} with authorization ${req.headers.authorization}`);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    const p = createOpenAICompatibleProvider({ id: "gw", name: "Gateway", baseUrl: `http://127.0.0.1:${port}/v1?token=querysecret`, apiKey: "supersecretvalue" });
    const events = await drain(p.run(input("openai-compatible:gw")));
    const message = (events.at(-1) as { message: string }).message;
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(message).toContain("401");
    expect(message).not.toContain("supersecretvalue");
    expect(message).not.toContain("querysecret");
  });

  it("keeps the key out of a failed connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed for http://box:1/v1?key=querysecret with Bearer supersecretvalue"); }));
    const p = createOpenAICompatibleProvider({ id: "gw", name: "Gateway", baseUrl: "http://box:1/v1?key=querysecret", apiKey: "supersecretvalue" });
    const message = ((await drain(p.run(input("openai-compatible:gw")))).at(-1) as { message: string }).message;
    expect(message).not.toContain("querysecret");
    expect(message).not.toContain("supersecretvalue");
  });

  it("keeps the API key out of a vendor error body", async () => {
    stubFetch(() => new Response('{"error":"Incorrect API key provided: ok-1234567890"}', { status: 401 }));
    const message = ((await drain(createApiProviders({ openai: "ok-1234567890" })["openai-api"].run(input("openai-api")))).at(-1) as { message: string }).message;
    expect(message).not.toContain("ok-1234567890");
  });
});
