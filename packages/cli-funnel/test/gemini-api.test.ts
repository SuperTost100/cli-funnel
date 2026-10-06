import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect } from "../src/providers/base.js";
import { createApiProviders } from "../src/providers/api.js";
import type { RunInput } from "../src/types.js";

// Fixtures follow the shapes in the Gemini API reference. They were written by hand, not recorded.
const fx = (n: string) => readFileSync(new URL(`./fixtures/gemini-api/${n}`, import.meta.url), "utf8");
const IMAGE = { type: "image" as const, mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
const SCHEMA = { schema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] } };
const input = (over: Partial<RunInput> = {}): RunInput => ({
  selection: { provider: "gemini-api", model: "gemini-3.8-flash", cwd: "/tmp", access: "full" },
  prompt: "Say hello.",
  ...over,
});
const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function stubFetch(respond: (url: string) => Response): Call[] {
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

const provider = () => createApiProviders({ gemini: "test-key" })["gemini-api"];

describe("gemini-api", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends contents, system instruction, images, JSON schema and output limit", async () => {
    const calls = stubFetch(() => sse(""));
    for await (const _ of provider().run(input({ system: "Be terse.", attachments: [IMAGE], responseSchema: SCHEMA, maxOutputTokens: 100 }))) {
      /* drain */
    }
    const [call] = calls;
    expect(call!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
    expect(call!.headers["x-goog-api-key"]).toBe("test-key");
    expect(call!.body.systemInstruction).toEqual({ parts: [{ text: "Be terse." }] });
    expect(call!.body.contents).toEqual([{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: IMAGE.data } }, { text: "Say hello." }] }]);
    expect(call!.body.generationConfig).toEqual({ maxOutputTokens: 100, responseMimeType: "application/json", responseJsonSchema: SCHEMA.schema });
  });

  it("maps text, thoughts and usage", async () => {
    stubFetch(() => sse(fx("stream.sse")));
    const events = [];
    for await (const e of provider().run(input())) events.push(e);
    expect(events.filter((e) => e.type === "reasoning.delta")).toEqual([{ type: "reasoning.delta", text: "Weighing the request." }]);
    expect(events.filter((e) => e.type === "text.delta").map((e) => (e as { text: string }).text).join("")).toBe("Hello there.");
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 9, outputTokens: 15, cachedInputTokens: 4, reasoningTokens: 12, totalTokens: 24 },
    });
    const r = await collect((async function* () { yield* events; })(), input());
    expect(r.text).toBe("Hello there.");
    expect(r.finishReason).toBe("stop");
  });

  it("replays history with the model role on resume", async () => {
    const calls = stubFetch(() => sse(fx("stream.sse")));
    const first = await collect(provider().run(input()), input());
    for await (const _ of provider().run(input({ prompt: "Again.", sessionId: first.sessionId }))) {
      /* drain */
    }
    expect(calls[1]!.body.contents).toEqual([
      { role: "user", parts: [{ text: "Say hello." }] },
      { role: "model", parts: [{ text: "Hello there." }] },
      { role: "user", parts: [{ text: "Again." }] },
    ]);
  });

  it("reports a safety stop as denied", async () => {
    stubFetch(() => sse('data: {"candidates": [{"finishReason": "SAFETY","index": 0}]}\n\n'));
    const r = await collect(provider().run(input()), input());
    expect(r.finishReason).toBe("denied");
  });

  it("reports a blocked prompt as denied", async () => {
    stubFetch(() => sse('data: {"promptFeedback": {"blockReason": "SAFETY"}}\n\n'));
    const r = await collect(provider().run(input()), input());
    expect(r.finishReason).toBe("denied");
  });

  it("turns an HTTP error into an error event", async () => {
    stubFetch(() => new Response('{"error":{"message":"API key not valid"}}', { status: 400 }));
    const events = [];
    for await (const e of provider().run(input())) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cli-failed", message: expect.stringContaining("Gemini API 400") });
  });

  it("lists text models across pages and drops aliases and non-chat models", async () => {
    const pages = JSON.parse(fx("models.json")).pages;
    const calls = stubFetch((url) => Response.json(url.includes("pageToken=p2") ? pages[1] : pages[0]));
    const models = await provider().models();
    expect(models.map((m) => m.id)).toEqual(["gemini-3.1-pro", "gemini-3.8-flash", "gemma-4-27b-it"]);
    expect(models.find((m) => m.id === "gemini-3.8-flash")).toMatchObject({ name: "Gemini 3.8 Flash", provider: "gemini-api", efforts: [] });
    expect(calls.map((c) => c.headers["x-goog-api-key"])).toEqual(["test-key", "test-key"]);
  });

  it("asks for a key when none is set", async () => {
    const old = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const p = createApiProviders()["gemini-api"];
      expect((await p.authStatus()).loggedIn).toBe(false);
      await expect(p.models()).rejects.toMatchObject({ code: "not-logged-in" });
    } finally {
      if (old !== undefined) process.env.GEMINI_API_KEY = old;
    }
  });
});
