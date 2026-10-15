import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createApiProviders } from "../src/providers/api.js";
import { anthropicAdaptive, anthropicEfforts, geminiEfforts, openaiEfforts } from "../src/providers/efforts.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import type { FunnelEvent, Provider, ProviderId, RunInput } from "../src/types.js";

// Fixtures follow the shapes in the vendor API references. They were written by hand, not recorded.
const fx = (dir: string, n: string) => readFileSync(new URL(`./fixtures/${dir}/${n}`, import.meta.url), "utf8");
const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const input = (provider: ProviderId, model: string, over: Partial<RunInput> & { effort?: string } = {}): RunInput => {
  const { effort, ...rest } = over;
  return { selection: { provider, model, cwd: "/tmp", access: "full", ...(effort ? { effort } : {}) }, prompt: "Say hello.", ...rest };
};
const SAMPLING = { temperature: 0.2, topP: 0.9, stop: ["END"], seed: 7 };

interface Call {
  url: string;
  body: any;
}

function stubFetch(respond: (url: string) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
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
const ids = (efforts: { id: string }[]) => efforts.map((e) => e.id);
const api = () => createApiProviders({ anthropic: "k", openai: "k", gemini: "k" });

describe("effort tables", () => {
  it("lists the Anthropic levels each model takes", () => {
    expect(ids(anthropicEfforts("claude-opus-5-5"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(ids(anthropicEfforts("claude-sonnet-5-5"))).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(ids(anthropicEfforts("claude-sonnet-4-6"))).toEqual(["low", "medium", "high", "max"]);
    expect(ids(anthropicEfforts("claude-opus-4-6"))).toEqual(["low", "medium", "high", "max"]);
    expect(ids(anthropicEfforts("claude-opus-4-5-20251101"))).toEqual(["low", "medium", "high"]);
    expect(anthropicEfforts("claude-sonnet-4-5-20250929")).toEqual([]);
    expect(anthropicEfforts("claude-opus-4-20250514")).toEqual([]);
    expect(anthropicEfforts("claude-haiku-4-5-20251001")).toEqual([]);
    expect(anthropicEfforts("claude-3-5-sonnet-20241022")).toEqual([]);
  });

  it("uses manual thinking budgets, not adaptive thinking, on Opus 4.5", () => {
    expect(anthropicAdaptive("claude-opus-4-5-20251101")).toBe(false);
    expect(anthropicAdaptive("claude-opus-4-6")).toBe(true);
    expect(anthropicAdaptive("claude-sonnet-5-5")).toBe(true);
    expect(anthropicAdaptive("claude-sonnet-4-5-20250929")).toBe(false);
  });

  it("limits OpenAI levels to reasoning models", () => {
    expect(ids(openaiEfforts("gpt-5.5"))).toEqual(["low", "medium", "high"]);
    expect(ids(openaiEfforts("o4-mini"))).toEqual(["low", "medium", "high"]);
    for (const m of ["gpt-4.1", "gpt-4o", "gpt-5-chat-latest", "o1-mini", "o1-preview"]) expect(openaiEfforts(m)).toEqual([]);
  });

  it("gives Gemini 3 and later a thinking level, and Gemini 2.5 none", () => {
    expect(ids(geminiEfforts("gemini-3.8-flash"))).toEqual(["low", "medium", "high"]);
    expect(ids(geminiEfforts("gemini-3-pro-preview"))).toEqual(["low", "high"]);
    expect(ids(geminiEfforts("gemini-3.1-pro"))).toEqual(["low", "medium", "high"]);
    expect(geminiEfforts("gemini-2.5-pro")).toEqual([]);
    expect(geminiEfforts("gemma-4-27b-it")).toEqual([]);
  });
});

describe("model lists carry efforts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sets efforts on Anthropic models", async () => {
    stubFetch(() => Response.json(JSON.parse(fx("anthropic-api", "models.json"))));
    const models = await api()["anthropic-api"].models();
    expect(models.map((m) => [m.id, ids(m.efforts).length])).toEqual([
      ["claude-opus-5-5", 5],
      ["claude-sonnet-5-5", 5],
      ["claude-sonnet-4-5-20250929", 0],
    ]);
  });

  it("sets efforts on OpenAI models", async () => {
    stubFetch(() => Response.json(JSON.parse(fx("openai-api", "models.json"))));
    const models = await api()["openai-api"].models();
    expect(models.map((m) => [m.id, ids(m.efforts).length])).toEqual([
      ["gpt-4.1", 0],
      ["gpt-5.5", 3],
      ["o4-mini", 3],
    ]);
  });

  it("declares effort and sampling on the API providers", () => {
    for (const p of Object.values(api())) expect(p.capabilities).toMatchObject({ effort: true, sampling: true });
  });
});

describe("anthropic-api controls", () => {
  afterEach(() => vi.unstubAllGlobals());
  const model = "claude-sonnet-5-5";

  it("sends adaptive thinking, effort and sampling", async () => {
    const calls = stubFetch(() => sse(""));
    await drain(api()["anthropic-api"].run(input("anthropic-api", model, { effort: "medium", sampling: SAMPLING })));
    expect(calls[0]!.body).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ["END"],
    });
    expect(calls[0]!.body).not.toHaveProperty("seed");
  });

  it("merges effort with the JSON schema in output_config", async () => {
    const calls = stubFetch(() => sse(""));
    const schema = { schema: { type: "object" } };
    await drain(api()["anthropic-api"].run(input("anthropic-api", model, { effort: "low", responseSchema: schema })));
    expect(calls[0]!.body.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: schema.schema } });
  });

  it("sends neither thinking nor output_config by default, and effort without thinking on Opus 4.5", async () => {
    const calls = stubFetch(() => sse(""));
    await drain(api()["anthropic-api"].run(input("anthropic-api", model)));
    await drain(api()["anthropic-api"].run(input("anthropic-api", "claude-opus-4-5-20251101", { effort: "high" })));
    expect(calls[0]!.body).not.toHaveProperty("thinking");
    expect(calls[0]!.body).not.toHaveProperty("output_config");
    expect(calls[1]!.body).not.toHaveProperty("thinking");
    expect(calls[1]!.body.output_config).toEqual({ effort: "high" });
  });

  it("maps thinking deltas to reasoning events", async () => {
    stubFetch(() => sse(fx("anthropic-api", "thinking.sse")));
    const events = await drain(api()["anthropic-api"].run(input("anthropic-api", model, { effort: "high" })));
    expect(events.filter((e) => e.type === "reasoning.delta")).toEqual([
      { type: "reasoning.delta", text: "The user wants a greeting." },
      { type: "reasoning.delta", text: " Keep it short." },
    ]);
    expect(events.filter((e) => e.type === "text.delta").map((e) => (e as { text: string }).text).join("")).toBe("Hello there.");
  });

  it("skips the empty thinking deltas of omitted thinking", async () => {
    stubFetch(() => sse(fx("anthropic-api", "omitted.sse")));
    const events = await drain(api()["anthropic-api"].run(input("anthropic-api", model)));
    expect(events.some((e) => e.type === "reasoning.delta")).toBe(false);
  });
});

describe("openai-api controls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends reasoning_effort and sampling", async () => {
    const calls = stubFetch(() => sse(fx("openai-api", "stream.sse")));
    await drain(api()["openai-api"].run(input("openai-api", "gpt-5.5", { effort: "high", sampling: SAMPLING })));
    expect(calls[0]!.body).toMatchObject({ reasoning_effort: "high", temperature: 0.2, top_p: 0.9, stop: ["END"], seed: 7 });
  });

  it("sends none of them by default", async () => {
    const calls = stubFetch(() => sse(fx("openai-api", "stream.sse")));
    await drain(api()["openai-api"].run(input("openai-api", "gpt-5.5")));
    for (const k of ["reasoning_effort", "temperature", "top_p", "stop", "seed"]) expect(calls[0]!.body).not.toHaveProperty(k);
  });

  it("keeps a temperature of zero", async () => {
    const calls = stubFetch(() => sse(fx("openai-api", "stream.sse")));
    await drain(api()["openai-api"].run(input("openai-api", "gpt-4.1", { sampling: { temperature: 0, seed: 0 } })));
    expect(calls[0]!.body).toMatchObject({ temperature: 0, seed: 0 });
  });
});

describe("gemini-api controls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a thinking level, includeThoughts and sampling", async () => {
    const calls = stubFetch(() => sse(""));
    await drain(api()["gemini-api"].run(input("gemini-api", "gemini-3.8-flash", { effort: "low", sampling: SAMPLING })));
    expect(calls[0]!.body.generationConfig).toEqual({
      thinkingConfig: { thinkingLevel: "low", includeThoughts: true },
      temperature: 0.2,
      topP: 0.9,
      stopSequences: ["END"],
      seed: 7,
    });
  });

  it("sends an empty generationConfig by default", async () => {
    const calls = stubFetch(() => sse(""));
    await drain(api()["gemini-api"].run(input("gemini-api", "gemini-3.8-flash")));
    expect(calls[0]!.body.generationConfig).toEqual({});
  });
});

describe("openai-compatible controls", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ID = "openai-compatible:local" as const;
  const local = (over = {}) => createOpenAICompatibleProvider({ id: "local", name: "Local", baseUrl: "http://box:1/v1", ...over });

  it("takes sampling and sends it", async () => {
    const calls = stubFetch(() => sse(fx("openai-compatible", "chat.sse")));
    const p = local();
    expect(p.capabilities).toMatchObject({ effort: false, sampling: true });
    await drain(p.run(input(ID, "smollm2:135m", { sampling: SAMPLING })));
    expect(calls[0]!.body).toMatchObject({ temperature: 0.2, top_p: 0.9, stop: ["END"], seed: 7 });
  });

  it("offers the configured efforts on every model and sends the choice", async () => {
    const calls = stubFetch((url) => (url.endsWith("/models") ? Response.json(JSON.parse(fx("openai-compatible", "models.json"))) : sse(fx("openai-compatible", "chat.sse"))));
    const p = local({ efforts: ["low", "high"] });
    expect(p.capabilities.effort).toBe(true);
    const models = await p.models();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) expect(ids(m.efforts)).toEqual(["low", "high"]);
    await drain(p.run(input(ID, "qwen3:0.6b", { effort: "high" })));
    expect(calls.at(-1)!.body.reasoning_effort).toBe("high");
  });
});

describe("funnel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses sampling on a provider that does not take it", async () => {
    const fake = {
      id: "claude",
      displayName: "Fake CLI",
      capabilities: { access: [], effort: false, contextWindow: false, fast: false, resume: false, approvals: false, images: false, system: "prompt", schema: "prompt" },
      detect: async () => ({ installed: true, testedRange: { min: "0" } }),
    } as unknown as Provider;
    const funnel = createFunnel({ allowUnlistedModels: true, providers: { claude: fake } });
    await expect(funnel.run(input("claude", "x", { sampling: { temperature: 0 } }))).rejects.toMatchObject({ code: "unsupported" });
  });

  it("refuses an effort the model lacks", async () => {
    stubFetch(() => Response.json(JSON.parse(fx("openai-api", "models.json"))));
    const funnel = createFunnel({ apiKeys: { openai: "k" } });
    await expect(funnel.run(input("openai-api", "gpt-4.1", { effort: "high" }))).rejects.toMatchObject({ code: "invalid-selection" });
  });
});
