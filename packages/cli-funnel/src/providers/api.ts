import { randomUUID } from "node:crypto";
import { readSSE } from "../util/sse.js";
import {
  FunnelError,
  type ApiProviderId,
  type FunnelEvent,
  type ModelInfo,
  type Provider,
  type RunInput,
} from "../types.js";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

interface ApiSpec {
  id: ApiProviderId;
  displayName: string;
  envVar: string;
  keyHint: string;
  listModels(key: string): Promise<ModelInfo[]>;
  stream(key: string, input: RunInput, messages: Msg[]): AsyncGenerator<FunnelEvent>;
}

const NO_EFFORT = { efforts: [], contextWindows: [], fast: false, source: "cli" as const };

const anthropic: ApiSpec = {
  id: "anthropic-api",
  displayName: "Anthropic API",
  envVar: "ANTHROPIC_API_KEY",
  keyHint: "console.anthropic.com",
  async listModels(key) {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw new FunnelError(`Anthropic API returned ${res.status}.`, "cli-failed");
    const body = (await res.json()) as { data: { id: string; display_name?: string }[] };
    return body.data.map((m) => ({ id: m.id, name: m.display_name ?? m.id, provider: "anthropic-api", ...NO_EFFORT }));
  },
  async *stream(key, input, messages) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: input.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: input.selection.model, max_tokens: 8192, stream: true, messages }),
    });
    if (!res.ok) return yield { type: "error", message: `Anthropic API ${res.status}: ${await res.text()}`, code: "cli-failed" };
    let inTok = 0;
    let outTok = 0;
    let cached = 0;
    let stop = "stop";
    for await (const { data } of readSSE(res)) {
      const e = JSON.parse(data);
      if (e.type === "message_start") {
        inTok = e.message.usage?.input_tokens ?? 0;
        cached = e.message.usage?.cache_read_input_tokens ?? 0;
      } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") yield { type: "text.delta", text: e.delta.text };
      else if (e.type === "message_delta") {
        outTok = e.usage?.output_tokens ?? outTok;
        stop = e.delta?.stop_reason ?? stop;
      } else if (e.type === "error") return yield { type: "error", message: e.error?.message ?? "API error" };
    }
    yield { type: "usage", usage: { inputTokens: inTok, outputTokens: outTok, cachedInputTokens: cached, totalTokens: inTok + outTok } };
    yield { type: "done", text: "", finishReason: stop === "refusal" ? "denied" : "stop" };
  },
};

const openai: ApiSpec = {
  id: "openai-api",
  displayName: "OpenAI API",
  envVar: "OPENAI_API_KEY",
  keyHint: "platform.openai.com",
  async listModels(key) {
    const res = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) throw new FunnelError(`OpenAI API returned ${res.status}.`, "cli-failed");
    const body = (await res.json()) as { data: { id: string }[] };
    return body.data
      .filter((m) => /^(gpt-|o\d|chatgpt)/.test(m.id) && !/(audio|realtime|tts|transcribe|image|search|embedding|moderation|instruct)/.test(m.id))
      .map((m) => ({ id: m.id, name: m.id, provider: "openai-api" as const, ...NO_EFFORT }))
      .sort((a, b) => a.id.localeCompare(b.id));
  },
  async *stream(key, input, messages) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: input.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: input.selection.model, messages, stream: true, stream_options: { include_usage: true } }),
    });
    if (!res.ok) return yield { type: "error", message: `OpenAI API ${res.status}: ${await res.text()}`, code: "cli-failed" };
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    let stop = "stop";
    for await (const { data } of readSSE(res)) {
      if (data === "[DONE]") break;
      const e = JSON.parse(data);
      const choice = e.choices?.[0];
      if (choice?.delta?.content) yield { type: "text.delta", text: choice.delta.content };
      if (choice?.finish_reason) stop = choice.finish_reason;
      if (e.usage) usage = e.usage;
    }
    if (usage) yield { type: "usage", usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } };
    yield { type: "done", text: "", finishReason: stop === "content_filter" ? "denied" : "stop" };
  },
};

// ponytail: conversation history lives in this process only. Persist it yourself if sessions must survive a restart.
const histories = new Map<string, Msg[]>();

function makeApiProvider(spec: ApiSpec, getKey: () => string | undefined): Provider {
  const key = () => {
    const k = getKey() ?? process.env[spec.envVar];
    if (!k) throw new FunnelError(`Set ${spec.envVar} (get a key at ${spec.keyHint}) or pass it to createFunnel({ apiKeys }).`, "not-logged-in");
    return k;
  };
  return {
    id: spec.id,
    displayName: spec.displayName,
    binary: "fetch",
    capabilities: { access: [], effort: false, contextWindow: false, fast: false, resume: true, approvals: false },
    detect: async () => ({ installed: true, testedRange: { min: "0" }, withinTestedRange: true }),
    authStatus: async () => ({ loggedIn: !!(getKey() ?? process.env[spec.envVar]), method: "API key" }),
    login() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "error" as const, message: `${spec.displayName} uses an API key. Set ${spec.envVar}.` };
        },
        sendCode() {},
        cancel() {},
      };
    },
    logout: async () => {
      throw new FunnelError(`Remove ${spec.envVar} from your environment to sign out.`, "unsupported");
    },
    update: async () => ({ changed: false, output: "API providers have nothing to update." }),
    models: async () => spec.listModels(key()),
    async *run(input) {
      const sessionId = input.sessionId ?? randomUUID();
      const messages = [...(histories.get(sessionId) ?? []), { role: "user" as const, content: input.prompt }];
      yield { type: "session", sessionId, model: input.selection.model };
      let text = "";
      for await (const e of spec.stream(key(), input, messages)) {
        if (e.type === "text.delta") text += e.text;
        yield e;
      }
      histories.set(sessionId, [...messages, { role: "assistant", content: text }]);
    },
  };
}

export const createApiProviders = (keys: { anthropic?: string; openai?: string } = {}): Record<ApiProviderId, Provider> => ({
  "anthropic-api": makeApiProvider(anthropic, () => keys.anthropic),
  "openai-api": makeApiProvider(openai, () => keys.openai),
});
