import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createApiProviders } from "../src/providers/api.js";
import { memoryHistory } from "../src/providers/history.js";
import { createOllamaProvider } from "../src/providers/ollama/index.js";
import { mapChatLine } from "../src/providers/ollama/parser.js";
import { chatToolCalls } from "../src/providers/wire.js";
import { createHandler } from "../src/server/handler.js";
import type { FunnelEvent, Message, Provider, ProviderId, RunInput, ToolDefinition } from "../src/types.js";

// Fixtures follow the shapes in the vendor API references. They were written by hand, not recorded.
const fx = (dir: string, n: string) => readFileSync(new URL(`./fixtures/${dir}/${n}`, import.meta.url), "utf8");
const sel = (provider: ProviderId, model = "m-1") => ({ provider, model, cwd: "/tmp", access: "full" as const });
const WEATHER: ToolDefinition = {
  name: "get_weather",
  description: "Weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
const TIME: ToolDefinition = { name: "get_time" };

function stubFetch(...bodies: string[]) {
  const sent: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit = {}) => {
      sent.push(JSON.parse(String(init.body)));
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
const of = <T extends FunnelEvent["type"]>(events: FunnelEvent[], type: T) => events.filter((e): e is Extract<FunnelEvent, { type: T }> => e.type === type);

afterEach(() => vi.unstubAllGlobals());

describe("anthropic-api tools", () => {
  const provider = () => createApiProviders({ anthropic: "k" })["anthropic-api"];

  it("sends tools and tool_choice, and streams the call with its arguments", async () => {
    const sent = stubFetch(fx("anthropic-api", "tool-use.sse"));
    const events = await drain(provider().run({ selection: sel("anthropic-api"), prompt: "Weather in Turin?", tools: [WEATHER, TIME], toolChoice: "required" }));
    expect(sent[0].tools).toEqual([
      { name: "get_weather", description: "Weather for a city.", input_schema: WEATHER.parameters },
      { name: "get_time", input_schema: { type: "object", properties: {} } },
    ]);
    expect(sent[0].tool_choice).toEqual({ type: "any" });
    expect(of(events, "tool_call.delta").map((e) => e.arguments)).toEqual(['{"city": "Tur', 'in"}']);
    expect(of(events, "tool_call")).toEqual([{ type: "tool_call", id: "toolu_01A", name: "get_weather", input: { city: "Turin" } }]);
    expect(of(events, "done")[0]!.finishReason).toBe("tool_calls");
  });

  it("keeps the thinking block with the call in history and appends the tool result", async () => {
    const sent = stubFetch(fx("anthropic-api", "tool-use.sse"), fx("anthropic-api", "omitted.sse"));
    const history = memoryHistory();
    const base = { selection: sel("anthropic-api"), history, sessionId: "s", tools: [WEATHER] };
    await drain(provider().run({ ...base, prompt: "Weather in Turin?" }));
    await drain(provider().run({ ...base, prompt: "", messages: [{ role: "user", content: [{ type: "tool_result", toolCallId: "toolu_01A", output: "12 C, fog" }] }] }));
    expect(sent[1].messages).toEqual([
      { role: "user", content: "Weather in Turin?" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need the weather tool.", signature: "EqQBCgIYAhIM" },
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_01A", name: "get_weather", input: { city: "Turin" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01A", content: "12 C, fog" }] },
    ]);
  });

  it("maps tool parts in messages, tool results first", async () => {
    const sent = stubFetch(fx("anthropic-api", "omitted.sse"));
    const messages: Message[] = [
      { role: "user", content: "Weather?" },
      { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "get_weather", input: { city: "Turin" } }] },
      { role: "user", content: [{ type: "text", text: "Thanks." }, { type: "tool_result", toolCallId: "t1", output: "boom", isError: true }] },
    ];
    await drain(provider().run({ selection: sel("anthropic-api"), prompt: "", messages, toolChoice: { name: "get_weather" } }));
    expect(sent[0].tool_choice).toEqual({ type: "tool", name: "get_weather" });
    expect(sent[0].messages[1].content).toEqual([{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Turin" } }]);
    expect(sent[0].messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true },
      { type: "text", text: "Thanks." },
    ]);
  });
});

describe("openai-api tools", () => {
  const provider = () => createApiProviders({ openai: "k" })["openai-api"];

  it("collects parallel calls from deltas keyed by index", async () => {
    const sent = stubFetch(fx("openai-api", "tool-calls.sse"));
    const events = await drain(provider().run({ selection: sel("openai-api"), prompt: "Weather and time?", tools: [WEATHER, TIME], toolChoice: { name: "get_weather" } }));
    expect(sent[0].tools[0]).toEqual({ type: "function", function: { name: "get_weather", description: "Weather for a city.", parameters: WEATHER.parameters } });
    expect(sent[0].tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
    expect(of(events, "tool_call.delta")).toEqual([
      { type: "tool_call.delta", id: "call_A", name: "get_weather", arguments: '{"city":' },
      { type: "tool_call.delta", id: "call_A", name: "get_weather", arguments: ' "Turin"}' },
      { type: "tool_call.delta", id: "call_B", name: "get_time", arguments: "{}" },
    ]);
    expect(of(events, "tool_call").map(({ id, input }) => ({ id, input }))).toEqual([
      { id: "call_A", input: { city: "Turin" } },
      { id: "call_B", input: {} },
    ]);
    expect(of(events, "done")[0]!.finishReason).toBe("tool_calls");
  });

  it("sends a stateless tool loop as assistant tool_calls and tool messages", async () => {
    const sent = stubFetch(fx("openai-api", "stream.sse"));
    const messages: Message[] = [
      { role: "user", content: "Weather and time?" },
      { role: "assistant", content: [{ type: "tool_call", id: "call_A", name: "get_weather", input: { city: "Turin" } }, { type: "tool_call", id: "call_B", name: "get_time", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "call_A", output: "12 C" }, { type: "tool_result", toolCallId: "call_B", output: "late", isError: true }] },
    ];
    await drain(provider().run({ selection: sel("openai-api"), prompt: "", messages, tools: [WEATHER, TIME] }));
    expect(sent[0].messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_A", type: "function", function: { name: "get_weather", arguments: '{"city":"Turin"}' } },
          { id: "call_B", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_A", content: "12 C" },
      { role: "tool", tool_call_id: "call_B", content: "Error: late" },
    ]);
  });

  it("stores a turn that only called tools, so the session can take the results", async () => {
    const sent = stubFetch(fx("openai-api", "tool-calls.sse"), fx("openai-api", "stream.sse"));
    const history = memoryHistory();
    const base = { selection: sel("openai-api"), history, sessionId: "s", tools: [WEATHER, TIME] };
    await drain(provider().run({ ...base, prompt: "Weather and time?" }));
    await drain(
      provider().run({ ...base, prompt: "", messages: [{ role: "user", content: [{ type: "tool_result", toolCallId: "call_A", output: "12 C" }, { type: "tool_result", toolCallId: "call_B", output: "9:00" }] }] }),
    );
    expect(sent[1].messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(sent[1].messages[1].tool_calls).toHaveLength(2);
  });

  it("parses arguments that are not JSON as a string", () => {
    const c = chatToolCalls(() => "gen");
    c.add([{ index: 0, function: { name: "f", arguments: "{oops" } }]);
    expect(c.finish()).toEqual([{ id: "gen", name: "f", input: "{oops" }]);
  });
});

describe("gemini-api tools", () => {
  const provider = () => createApiProviders({ gemini: "k" })["gemini-api"];

  it("sends declarations and a tool config, and gives calls without an id one", async () => {
    const sent = stubFetch(fx("gemini-api", "function-call.sse"));
    const history = memoryHistory();
    const events = await drain(
      provider().run({ selection: sel("gemini-api", "gemini-3.8-flash"), prompt: "Weather?", tools: [WEATHER], toolChoice: { name: "get_weather" }, history, sessionId: "g" }),
    );
    expect(sent[0].tools).toEqual([{ functionDeclarations: [{ name: "get_weather", description: "Weather for a city.", parametersJsonSchema: WEATHER.parameters }] }]);
    expect(sent[0].toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] } });
    const calls = of(events, "tool_call");
    expect(calls.map((c) => [c.name, c.input])).toEqual([
      ["get_weather", { city: "Turin" }],
      ["get_time", {}],
    ]);
    expect(calls[0]!.id).toMatch(/^call_/);
    expect(of(events, "done")[0]!.finishReason).toBe("tool_calls");
    // The stored parts keep the signature and carry the made-up id.
    const stored = (await history.get("gemini-api:g")) as { content: any[] }[];
    expect(stored[1]!.content[0]).toEqual({ functionCall: { name: "get_weather", args: { city: "Turin" }, id: calls[0]!.id }, thoughtSignature: "CiQBjz1rX2sig" });
  });

  it("finds the function name of a result in the stored history", async () => {
    const sent = stubFetch(fx("gemini-api", "function-call.sse"), fx("gemini-api", "stream.sse"));
    const history = memoryHistory();
    const base = { selection: sel("gemini-api", "gemini-3.8-flash"), history, sessionId: "g", tools: [WEATHER, TIME] };
    const calls = of(await drain(provider().run({ ...base, prompt: "Weather?" })), "tool_call");
    await drain(provider().run({ ...base, prompt: "", messages: [{ role: "user", content: calls.map((c) => ({ type: "tool_result" as const, toolCallId: c.id, output: "ok" })) }] }));
    expect(sent[1].contents[2]).toEqual({
      role: "user",
      parts: calls.map((c) => ({ functionResponse: { id: c.id, name: c.name, response: { output: "ok" } } })),
    });
  });

  it("signs the first call of a stateless turn on Gemini 3, and refuses a result for an unknown call", async () => {
    const sent = stubFetch(fx("gemini-api", "stream.sse"));
    const messages: Message[] = [
      { role: "user", content: "Weather?" },
      { role: "assistant", content: [{ type: "tool_call", id: "a", name: "get_weather", input: { city: "Turin" } }, { type: "tool_call", id: "b", name: "get_time", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "a", output: "12 C", isError: true }] },
    ];
    await drain(provider().run({ selection: sel("gemini-api", "gemini-3.8-flash"), prompt: "", messages }));
    expect(sent[0].contents[1].parts).toEqual([
      { functionCall: { id: "a", name: "get_weather", args: { city: "Turin" } }, thoughtSignature: "skip_thought_signature_validator" },
      { functionCall: { id: "b", name: "get_time", args: {} } },
    ]);
    expect(sent[0].contents[2].parts).toEqual([{ functionResponse: { id: "a", name: "get_weather", response: { error: "12 C" } } }]);
    await drain(provider().run({ selection: sel("gemini-api", "gemini-2.5-flash"), prompt: "", messages }));
    expect(sent[1].contents[1].parts[0].thoughtSignature).toBeUndefined();
    const orphan: Message[] = [{ role: "user", content: [{ type: "tool_result", toolCallId: "zzz", output: "x" }] }];
    await expect(drain(provider().run({ selection: sel("gemini-api"), prompt: "", messages: orphan }))).rejects.toThrow('"zzz"');
  });
});

describe("ollama tools", () => {
  const provider = () => createOllamaProvider({ baseUrl: "http://box:11434" });

  it("maps a tool call line to a tool_call event", () => {
    const events = fx("ollama", "tool-calls.ndjson").trim().split("\n").map((l) => JSON.parse(l)).flatMap((l) => mapChatLine(l));
    expect(of(events, "tool_call")).toEqual([{ type: "tool_call", id: "", name: "get_weather", input: { city: "Turin" } }]);
  });

  it("sends tools, ends with tool_calls and sends results as tool messages with the tool name", async () => {
    const sent = stubFetch(fx("ollama", "tool-calls.ndjson"), fx("ollama", "chat.ndjson"));
    const history = memoryHistory();
    const base = { selection: sel("ollama"), history, sessionId: "o", tools: [WEATHER] };
    const events = await drain(provider().run({ ...base, prompt: "Weather?" }));
    expect(sent[0].tools).toEqual([{ type: "function", function: { name: "get_weather", description: "Weather for a city.", parameters: WEATHER.parameters } }]);
    const [call] = of(events, "tool_call");
    expect(call!.id).toMatch(/^call_/);
    expect(of(events, "done")[0]!.finishReason).toBe("tool_calls");
    await drain(provider().run({ ...base, prompt: "", messages: [{ role: "user", content: [{ type: "tool_result", toolCallId: call!.id, output: "12 C" }] }] }));
    expect(sent[1].messages.slice(1)).toEqual([
      { role: "assistant", content: "", tool_calls: [{ id: call!.id, function: { name: "get_weather", arguments: { city: "Turin" } } }] },
      { role: "tool", content: "12 C", tool_name: "get_weather" },
    ]);
  });

  it("drops the tools for toolChoice none and refuses a forced call", async () => {
    const sent = stubFetch(fx("ollama", "chat.ndjson"));
    await drain(provider().run({ selection: sel("ollama"), prompt: "hi", tools: [WEATHER], toolChoice: "none" }));
    expect(sent[0].tools).toBeUndefined();
    const events = await drain(provider().run({ selection: sel("ollama"), prompt: "hi", tools: [WEATHER], toolChoice: "required" }));
    expect(of(events, "error")[0]).toMatchObject({ code: "unsupported" });
  });
});

describe("funnel and OpenAI endpoint", () => {
  const seen: RunInput[] = [];
  const fake = (id: ProviderId, tools: boolean, events: FunnelEvent[]): Provider => ({
    id,
    displayName: id,
    capabilities: { access: [], effort: false, contextWindow: false, fast: false, resume: true, approvals: false, images: true, messages: tools, tools, system: "native", schema: "native" },
    detect: async () => ({ installed: true, testedRange: { min: "0" } }),
    authStatus: async () => ({ loggedIn: true }),
    login: () => {
      throw new Error("no");
    },
    logout: async () => {},
    update: async () => ({ changed: false, output: "" }),
    models: async () => [{ id: "m-1", name: "m", provider: id, efforts: [], contextWindows: [], fast: false, source: "manifest" }],
    async *run(input) {
      seen.push(input);
      yield* events;
    },
  });
  const CALLS: FunnelEvent[] = [
    { type: "session", sessionId: "s1" },
    { type: "tool_call.delta", id: "call_A", name: "get_weather", arguments: '{"city":' },
    { type: "tool_call.delta", id: "call_A", name: "get_weather", arguments: '"Turin"}' },
    { type: "tool_call", id: "call_A", name: "get_weather", input: { city: "Turin" } },
    { type: "tool_call", id: "call_B", name: "get_time", input: {} },
    { type: "done", text: "", finishReason: "tool_calls" },
  ];
  const funnel = createFunnel({ providers: { claude: fake("claude", false, CALLS), "openai-api": fake("openai-api", true, CALLS) } });
  const handler = createHandler(funnel, { fsRoots: [tmpdir()], openai: { cwd: tmpdir() } });
  const chat = (body: object) =>
    handler(new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "openai-api/m-1", messages: [{ role: "user", content: "hi" }], ...body }) }));
  const OPENAI_TOOLS = [{ type: "function", function: { name: "get_weather", description: "Weather.", parameters: WEATHER.parameters } }];

  it("collects calls in pendingToolCalls and refuses tools on a CLI", async () => {
    const r = await funnel.run({ selection: sel("openai-api"), prompt: "hi", tools: [WEATHER] });
    expect(r.finishReason).toBe("tool_calls");
    expect(r.pendingToolCalls).toEqual([
      { id: "call_A", name: "get_weather", input: { city: "Turin" } },
      { id: "call_B", name: "get_time", input: {} },
    ]);
    await expect(funnel.run({ selection: sel("claude"), prompt: "hi", tools: [WEATHER] })).rejects.toMatchObject({ code: "unsupported" });
    const results: Message[] = [{ role: "user", content: [{ type: "tool_result", toolCallId: "x", output: "y" }] }];
    await expect(funnel.run({ selection: sel("claude"), messages: results })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("passes tools and tool_choice, and answers with tool_calls", async () => {
    seen.length = 0;
    const res = await (await chat({ tools: OPENAI_TOOLS, tool_choice: { type: "function", function: { name: "get_weather" } } })).json();
    expect(seen[0]!.tools).toEqual([{ name: "get_weather", description: "Weather.", parameters: WEATHER.parameters }]);
    expect(seen[0]!.toolChoice).toEqual({ name: "get_weather" });
    expect(res.choices[0].finish_reason).toBe("tool_calls");
    expect(res.choices[0].message).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_A", type: "function", function: { name: "get_weather", arguments: '{"city":"Turin"}' } },
        { id: "call_B", type: "function", function: { name: "get_time", arguments: "{}" } },
      ],
    });
  });

  it("streams tool calls as OpenAI does: id and name first, then argument pieces", async () => {
    const res = await chat({ tools: OPENAI_TOOLS, stream: true });
    const chunks = (await res.text())
      .split("\n\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)));
    const deltas = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(deltas).toEqual([
      { index: 0, id: "call_A", type: "function", function: { name: "get_weather", arguments: '{"city":' } },
      { index: 0, function: { arguments: '"Turin"}' } },
      { index: 1, id: "call_B", type: "function", function: { name: "get_time", arguments: "{}" } },
    ]);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
  });

  it("takes the assistant tool_calls and role tool messages of the next request", async () => {
    seen.length = 0;
    const res = await chat({
      tools: OPENAI_TOOLS,
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_A", type: "function", function: { name: "get_weather", arguments: '{"city":"Turin"}' } }, { id: "call_B", type: "function", function: { name: "get_time", arguments: "" } }] },
        { role: "tool", tool_call_id: "call_A", content: "12 C" },
        { role: "tool", tool_call_id: "call_B", content: [{ type: "text", text: "9:00" }] },
      ],
    });
    expect(res.status).toBe(200);
    expect(seen[0]!.messages).toEqual([
      { role: "user", content: "Weather?" },
      { role: "assistant", content: [{ type: "tool_call", id: "call_A", name: "get_weather", input: { city: "Turin" } }, { type: "tool_call", id: "call_B", name: "get_time", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "call_A", output: "12 C" }, { type: "tool_result", toolCallId: "call_B", output: "9:00" }] },
    ]);
  });

  it("answers 400 for tools on a provider that runs its own, and for a bad tool", async () => {
    const cli = await chat({ model: "claude/m-1", tools: OPENAI_TOOLS });
    expect(cli.status).toBe(400);
    expect((await cli.json()).error).toMatchObject({ param: "tools", code: "unsupported_value" });
    expect((await chat({ model: "claude/m-1", tool_choice: "auto" })).status).toBe(200);
    const bad = await chat({ tools: [{ type: "web_search" }] });
    expect((await bad.json()).error.param).toBe("tools[0]");
    const noId = await chat({ messages: [{ role: "tool", content: "x" }] });
    expect((await noId.json()).error.param).toBe("messages[0].tool_call_id");
  });
});
