import { readSSE } from "../util/sse.js";
import { runWithHistory } from "./history.js";
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
  /** A string, or vendor-shaped content parts when images are attached. */
  content: string | unknown[];
}

interface ApiSpec {
  id: ApiProviderId;
  displayName: string;
  envVar: string;
  keyHint: string;
  listModels(key: string): Promise<ModelInfo[]>;
  stream(key: string, input: RunInput, messages: Msg[]): AsyncGenerator<FunnelEvent>;
  /** The user turn in this vendor's content format. */
  userContent(input: RunInput): string | unknown[];
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
      body: JSON.stringify({
        model: input.selection.model,
        max_tokens: input.maxOutputTokens ?? 8192,
        stream: true,
        ...(input.system ? { system: input.system } : {}),
        ...(input.responseSchema ? { output_config: { format: { type: "json_schema", schema: input.responseSchema.schema } } } : {}),
        messages,
      }),
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
  userContent(input) {
    if (!input.attachments?.length) return input.prompt;
    return [
      ...input.attachments.map((a) => ({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } })),
      { type: "text", text: input.prompt },
    ];
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
      body: JSON.stringify({
        model: input.selection.model,
        // The system message is sent on every call and never stored in the session history.
        messages: input.system ? [{ role: "system", content: input.system }, ...messages] : messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(input.maxOutputTokens ? { max_completion_tokens: input.maxOutputTokens } : {}),
        ...(input.responseSchema
          ? { response_format: { type: "json_schema", json_schema: { name: input.responseSchema.name ?? "response", schema: input.responseSchema.schema } } }
          : {}),
      }),
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
  userContent(input) {
    if (!input.attachments?.length) return input.prompt;
    return [
      { type: "text", text: input.prompt },
      ...input.attachments.map((a) => ({ type: "image_url", image_url: { url: `data:${a.mediaType};base64,${a.data}` } })),
    ];
  },
};

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

/** Gemini ids that are aliases or models without text chat. Aliases like `gemini-flash-latest` break the versioned-id rule. */
const GEMINI_SKIP = /latest|embedding|aqa|tts|image|imagen|veo|live|audio|robotics|computer-use/;

/** Finish reasons where Gemini withheld or cut the answer for policy reasons. */
const GEMINI_BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

const gemini: ApiSpec = {
  id: "gemini-api",
  displayName: "Gemini API",
  envVar: "GEMINI_API_KEY",
  keyHint: "aistudio.google.com",
  async listModels(key) {
    const out: ModelInfo[] = [];
    let page = "";
    do {
      const res = await fetch(`${GEMINI}/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`, {
        headers: { "x-goog-api-key": key },
      });
      if (!res.ok) throw new FunnelError(`Gemini API returned ${res.status}.`, "cli-failed");
      const body = (await res.json()) as {
        models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
        nextPageToken?: string;
      };
      for (const m of body.models ?? []) {
        const id = m.name.replace(/^models\//, "");
        if (!m.supportedGenerationMethods?.includes("generateContent") || GEMINI_SKIP.test(id)) continue;
        out.push({ id, name: m.displayName ?? id, provider: "gemini-api", ...NO_EFFORT });
      }
      page = body.nextPageToken ?? "";
    } while (page);
    return out.sort((a, b) => a.id.localeCompare(b.id));
  },
  async *stream(key, input, messages) {
    const res = await fetch(`${GEMINI}/models/${encodeURIComponent(input.selection.model)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      signal: input.signal,
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: typeof m.content === "string" ? [{ text: m.content }] : m.content,
        })),
        ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
        generationConfig: {
          ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
          ...(input.responseSchema ? { responseMimeType: "application/json", responseJsonSchema: input.responseSchema.schema } : {}),
        },
      }),
    });
    if (!res.ok) return yield { type: "error", message: `Gemini API ${res.status}: ${await res.text()}`, code: "cli-failed" };
    let usage: Record<string, number> | undefined;
    let stop = "STOP";
    for await (const { data } of readSSE(res)) {
      const e = JSON.parse(data);
      if (e.error) return yield { type: "error", message: e.error.message ?? "Gemini API error" };
      if (e.promptFeedback?.blockReason) stop = "SAFETY";
      const candidate = e.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text !== "string" || !part.text) continue;
        yield part.thought ? { type: "reasoning.delta", text: part.text } : { type: "text.delta", text: part.text };
      }
      if (candidate?.finishReason) stop = candidate.finishReason;
      if (e.usageMetadata) usage = e.usageMetadata;
    }
    if (usage) {
      const inputTokens = usage.promptTokenCount ?? 0;
      // Thinking tokens are billed as output.
      const outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
      yield {
        type: "usage",
        usage: {
          inputTokens,
          outputTokens,
          cachedInputTokens: usage.cachedContentTokenCount,
          reasoningTokens: usage.thoughtsTokenCount,
          totalTokens: usage.totalTokenCount ?? inputTokens + outputTokens,
        },
      };
    }
    yield { type: "done", text: "", finishReason: GEMINI_BLOCKED.has(stop) ? "denied" : "stop" };
  },
  userContent(input) {
    if (!input.attachments?.length) return input.prompt;
    return [...input.attachments.map((a) => ({ inlineData: { mimeType: a.mediaType, data: a.data } })), { text: input.prompt }];
  },
};

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
    capabilities: {
      access: [],
      effort: false,
      contextWindow: false,
      fast: false,
      resume: true,
      approvals: false,
      images: true,
      system: "native",
      schema: "native",
    },
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
    run(input) {
      const user: Msg = { role: "user", content: spec.userContent(input) };
      return runWithHistory(input, user, (text): Msg => ({ role: "assistant", content: text }), (messages) => spec.stream(key(), input, messages));
    },
  };
}

export interface ApiKeys {
  anthropic?: string;
  openai?: string;
  gemini?: string;
}

export const createApiProviders = (keys: ApiKeys = {}): Record<ApiProviderId, Provider> => ({
  "anthropic-api": makeApiProvider(anthropic, () => keys.anthropic),
  "openai-api": makeApiProvider(openai, () => keys.openai),
  "gemini-api": makeApiProvider(gemini, () => keys.gemini),
});
