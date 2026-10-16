import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createApiProviders, openaiApis } from "../src/providers/api.js";
import { openaiEfforts } from "../src/providers/efforts.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { responsesBody, responsesEvents } from "../src/providers/responses.js";
import { createHandler } from "../src/server/handler.js";
import { inputToMessages } from "../src/server/responses.js";
import type { FunnelEvent, Message, Provider, ProviderId, RunInput } from "../src/types.js";

// Fixtures follow the event shapes in the OpenAI Responses API reference. They were written by hand, not recorded.
const fx = (n: string) => readFileSync(new URL(`./fixtures/openai-api/${n}`, import.meta.url), "utf8");
const sel = (provider: ProviderId, model: string) => ({ provider, model, cwd: "/tmp", access: "full" as const });
const IMAGE = { type: "image" as const, mediaType: "image/png" as const, data: "iVBORw0KGgo=" };

function stubFetch(...bodies: string[]) {
  const sent: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(bodies[Math.min(sent.length - 1, bodies.length - 1)], { status: 200 });
    }),
  );
  return sent;
}

const drain = async (it: AsyncIterable<FunnelEvent>) => {
  const out: FunnelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
/** Folds a fixture through the pure Responses parser. */
const fold = (sse: string) => {
  const f = responsesEvents();
  return sse
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .flatMap((l) => f.add(JSON.parse(l.slice(6))));
};

afterEach(() => vi.unstubAllGlobals());

describe("Responses stream parser", () => {
  it("maps text, reasoning summaries, a function call and usage", () => {
    expect(fold(fx("responses.sse"))).toEqual([
      { type: "session", sessionId: "resp_01A", model: "gpt-5-pro-2025-10-06" },
      { type: "reasoning.delta", text: "Weather needs a lookup." },
      { type: "reasoning.delta", text: "\n\n" },
      { type: "reasoning.delta", text: "Call the tool." },
      { type: "text.delta", text: "Let me " },
      { type: "text.delta", text: "check." },
      { type: "tool_call.delta", id: "call_W", name: "get_weather", arguments: '{"city":' },
      { type: "tool_call.delta", id: "call_W", name: "get_weather", arguments: '"Turin"}' },
      { type: "tool_call", id: "call_W", name: "get_weather", input: { city: "Turin" } },
      { type: "usage", usage: { inputTokens: 120, outputTokens: 90, cachedInputTokens: 64, reasoningTokens: 70, totalTokens: 210 } },
      { type: "done", text: "", finishReason: "tool_calls" },
    ]);
  });

  it("ends an incomplete response with length and a failed one with an error", () => {
    expect(fold(fx("responses-incomplete.sse")).at(-1)).toEqual({ type: "done", text: "", finishReason: "length" });
    expect(fold(fx("responses-failed.sse")).at(-1)).toMatchObject({ type: "error", message: "The model failed to generate a response." });
  });
});

describe("Responses request", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Weather?" }, IMAGE] },
    { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool_call", id: "call_W", name: "get_weather", input: { city: "Turin" } }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call_W", output: "12 C" }, { type: "text", text: "Umbrella?" }] },
  ];

  it("maps messages to input items and options to their fields", () => {
    const body = responsesBody(
      {
        selection: { ...sel("openai-api", "gpt-5-pro"), effort: "high" },
        prompt: "",
        messages,
        system: "Be brief.",
        maxOutputTokens: 500,
        sampling: { temperature: 0.2, stop: ["x"], seed: 1 },
        responseSchema: { schema: { type: "object" } },
        tools: [{ name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
        toolChoice: { name: "get_weather" },
      },
      true,
    );
    expect(body).toEqual({
      model: "gpt-5-pro",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Weather?" }, { type: "input_image", image_url: `data:image/png;base64,${IMAGE.data}` }] },
        { role: "assistant", content: "Checking." },
        { type: "function_call", call_id: "call_W", name: "get_weather", arguments: '{"city":"Turin"}' },
        { type: "function_call_output", call_id: "call_W", output: "12 C" },
        { role: "user", content: [{ type: "input_text", text: "Umbrella?" }] },
      ],
      stream: true,
      instructions: "Be brief.",
      max_output_tokens: 500,
      reasoning: { effort: "high", summary: "auto" },
      temperature: 0.2,
      text: { format: { type: "json_schema", name: "response", schema: { type: "object" }, strict: true } },
      tools: [{ type: "function", name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } }],
      tool_choice: { type: "function", name: "get_weather" },
    });
  });

  it("sends only the new messages and the previous response id on a session", () => {
    const body = responsesBody({ selection: sel("openai-api", "gpt-5-pro"), prompt: "", messages, sessionId: "resp_01A" });
    expect(body.previous_response_id).toBe("resp_01A");
    expect(body.input).toEqual([
      { type: "function_call_output", call_id: "call_W", output: "12 C" },
      { role: "user", content: [{ type: "input_text", text: "Umbrella?" }] },
    ]);
  });
});

describe("openai-api picks its API per model", () => {
  it("marks models with the APIs they take", () => {
    expect(openaiApis("gpt-5.5")).toEqual(["chat", "responses"]);
    expect(openaiApis("gpt-5-pro")).toEqual(["responses"]);
    expect(openaiApis("gpt-5.1-codex-max")).toEqual(["responses"]);
    expect(openaiApis("o3-deep-research")).toEqual([]);
    expect(openaiApis("chatgpt-4o-latest")).toEqual([]);
    expect(openaiEfforts("gpt-5-pro").map((e) => e.id)).toEqual(["high"]);
  });

  it("runs Responses-only models on /responses with the response id as the session", async () => {
    const sent = stubFetch(fx("responses.sse"), fx("responses-incomplete.sse"));
    const p = createApiProviders({ openai: "k" })["openai-api"];
    const events = await drain(p.run({ selection: sel("openai-api", "gpt-5-pro"), prompt: "Weather?" }));
    expect(sent[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(events[0]).toEqual({ type: "session", sessionId: "resp_01A", model: "gpt-5-pro-2025-10-06" });
    await drain(p.run({ selection: sel("openai-api", "gpt-5-pro"), prompt: "", sessionId: "resp_01A", messages: [{ role: "user", content: [{ type: "tool_result", toolCallId: "call_W", output: "12 C" }] }] }));
    expect(sent[1]!.body).toMatchObject({ previous_response_id: "resp_01A", input: [{ type: "function_call_output", call_id: "call_W", output: "12 C" }] });
  });

  it("keeps chat models on Chat Completions unless mode is responses", async () => {
    const sent = stubFetch(fx("stream.sse"));
    await drain(createApiProviders({ openai: "k" })["openai-api"].run({ selection: sel("openai-api", "gpt-5.5"), prompt: "hi" }));
    expect(sent[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    vi.unstubAllGlobals();
    const again = stubFetch(fx("responses-incomplete.sse"));
    const p = createApiProviders({}, { openai: { key: "k", mode: "responses" } })["openai-api"];
    const events = await drain(p.run({ selection: sel("openai-api", "gpt-5.5"), prompt: "hi" }));
    expect(again[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(events.at(-1)).toEqual({ type: "done", text: "", finishReason: "length" });
  });

  it("reports a 429 as a limit event before the error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"Rate limit reached"}}', { status: 429, headers: { "retry-after": "40" } })));
    const p = createApiProviders({}, { openai: { key: "k", retries: 0 } })["openai-api"];
    const events = await drain(p.run({ selection: sel("openai-api", "gpt-5-pro"), prompt: "hi" }));
    expect(events.map((e) => e.type)).toEqual(["limit", "error"]);
  });

  it("redacts the key from a Responses error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key sk-secret-123456789", { status: 401 })));
    const p = createApiProviders({ openai: "sk-secret-123456789" })["openai-api"];
    const events = await drain(p.run({ selection: sel("openai-api", "gpt-5-pro"), prompt: "hi" }));
    expect(JSON.stringify(events)).not.toContain("sk-secret-123456789");
  });
});

describe("OpenAI-compatible endpoints in Responses mode", () => {
  it("sends runs to /responses and marks models with the API", async () => {
    const sent = stubFetch(fx("responses-incomplete.sse"));
    const p = createOpenAICompatibleProvider({ id: "box", name: "Box", baseUrl: "http://box:1/v1", mode: "responses", models: ["m-1"] });
    await drain(p.run({ selection: sel(p.id, "m-1"), prompt: "hi" }));
    expect(sent[0]!.url).toBe("http://box:1/v1/responses");
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "m-1" }] })));
    expect((await p.models())[0]!.apis).toEqual(["responses"]);
  });
});

describe("POST /v1/responses", () => {
  const seen: RunInput[] = [];
  const fake = (id: ProviderId, tools: boolean, events: FunnelEvent[]): Provider => ({
    id,
    displayName: id,
    binary: "fake",
    capabilities: { access: tools ? [] : ["full"], effort: true, contextWindow: false, fast: false, resume: true, approvals: false, images: true, messages: tools, tools, sampling: tools, system: "native", schema: "native" },
    detect: async () => ({ installed: true, testedRange: { min: "0" } }),
    authStatus: async () => ({ loggedIn: true }),
    login: () => {
      throw new Error("no");
    },
    logout: async () => {},
    update: async () => ({ changed: false, output: "" }),
    models: async () => [{ id: "m-1", name: "m", provider: id, efforts: [{ id: "high", label: "High" }], contextWindows: [], fast: false, source: "manifest" }],
    async *run(input) {
      seen.push(input);
      yield* events;
    },
  });
  const EVENTS: FunnelEvent[] = [
    { type: "session", sessionId: "sess-1" },
    { type: "text.delta", text: "Let me " },
    { type: "text.delta", text: "check." },
    { type: "tool_call.delta", id: "call_W", name: "get_weather", arguments: '{"city":' },
    { type: "tool_call.delta", id: "call_W", name: "get_weather", arguments: '"Turin"}' },
    { type: "tool_call", id: "call_W", name: "get_weather", input: { city: "Turin" } },
    { type: "usage", usage: { inputTokens: 5, outputTokens: 7, cachedInputTokens: 2, totalTokens: 12 } },
    { type: "done", text: "", finishReason: "tool_calls" },
  ];
  const funnel = createFunnel({ providers: { claude: fake("claude", false, EVENTS), "openai-api": fake("openai-api", true, EVENTS) } });
  const handler = createHandler(funnel, { fsRoots: [tmpdir()], openai: { cwd: tmpdir() } });
  const post = (body: object) =>
    handler(new Request("http://x/v1/responses", { method: "POST", body: JSON.stringify({ model: "openai-api/m-1", input: "Weather?", ...body }) }));

  it("answers with output items, the session id as the response id, and usage", async () => {
    seen.length = 0;
    const res = await (await post({ instructions: "Be brief.", reasoning: { effort: "high" }, max_output_tokens: 50, temperature: 0.3 })).json();
    expect(seen[0]).toMatchObject({ system: "Be brief.", maxOutputTokens: 50, sampling: { temperature: 0.3 }, messages: [{ role: "user", content: "Weather?" }] });
    expect(seen[0]!.selection.effort).toBe("high");
    expect(res).toMatchObject({
      id: "sess-1",
      object: "response",
      status: "completed",
      model: "openai-api/m-1",
      output: [
        { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Let me check.", annotations: [] }] },
        { type: "function_call", call_id: "call_W", name: "get_weather", arguments: '{"city":"Turin"}', status: "completed" },
      ],
      usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 2 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 12 },
      x_funnel: { sessionId: "sess-1", runId: expect.stringMatching(/^run_/) },
    });
  });

  it("continues a session from previous_response_id and maps tool outputs", async () => {
    seen.length = 0;
    await post({
      previous_response_id: "sess-1",
      tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
      tool_choice: "required",
      input: [{ type: "function_call_output", call_id: "call_W", output: "12 C" }],
    });
    expect(seen[0]).toMatchObject({
      sessionId: "sess-1",
      tools: [{ name: "get_weather", parameters: { type: "object" } }],
      toolChoice: "required",
      messages: [{ role: "user", content: [{ type: "tool_result", toolCallId: "call_W", output: "12 C" }] }],
    });
  });

  it("streams the Responses events in order", async () => {
    const res = await post({ stream: true });
    const raw = await res.text();
    const events = raw
      .split("\n\n")
      .filter(Boolean)
      .map((block) => ({ event: /^event: (.+)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(block)![1]!) }));
    expect(events.every((e) => e.event === e.data.type)).toBe(true);
    expect(events.map((e) => e.data.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.map((e) => e.data.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events[0]!.data.response.id).toBe("sess-1");
    expect(events.at(-1)!.data.response.output[1]).toMatchObject({ type: "function_call", call_id: "call_W" });
  });

  it("refuses what it cannot honour with a 400", async () => {
    const cases: [object, string][] = [
      [{ background: true }, "background"],
      [{ text: { format: { type: "json_object" } } }, "text.format"],
      [{ tools: [{ type: "web_search" }] }, "tools[0]"],
      [{ model: "claude/m-1", tools: [{ type: "function", name: "f" }] }, "tools"],
      [{ model: "claude/m-1", temperature: 0.5 }, "temperature"],
      [{ input: [{ type: "item_reference", id: "x" }] }, "input[0]"],
      [{ input: [{ role: "user", content: [{ type: "input_image", image_url: "https://x/y.png" }] }] }, "input[0].content[0]"],
    ];
    for (const [body, param] of cases) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.param).toBe(param);
    }
  });

  it("reads message, developer, function_call and reasoning items", () => {
    expect(
      inputToMessages([
        { role: "developer", content: "No markdown." },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Weather?" }] },
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking." }] },
        { type: "function_call", call_id: "a", name: "f", arguments: "{}" },
        { type: "function_call", call_id: "b", name: "g", arguments: "{}" },
        { type: "function_call_output", call_id: "a", output: "1" },
        { type: "function_call_output", call_id: "b", output: [{ type: "input_text", text: "2" }] },
      ]),
    ).toEqual({
      system: ["No markdown."],
      messages: [
        { role: "user", content: [{ type: "text", text: "Weather?" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_call", id: "a", name: "f", input: {} },
            { type: "tool_call", id: "b", name: "g", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", toolCallId: "a", output: "1" }, { type: "tool_result", toolCallId: "b", output: "2" }] },
      ],
    });
  });
});
