import { readSSE } from "../util/sse.js";
import { redactErrors } from "../util/redact.js";
import { anthropicAdaptive, anthropicEfforts, geminiEfforts, openaiEfforts } from "./efforts.js";
import { parseArguments } from "../messages.js";
import { runWithHistory } from "./history.js";
import { bearer, fetchRetrying, httpAccount, httpCapabilities, httpError, jsonHeaders, mergeHeaders, truncated, type RetryOptions } from "./http.js";
import {
  anthropicMessages,
  anthropicToolChoice,
  anthropicTools,
  chatAssistant,
  chatMessages,
  chatToolCalls,
  chatToolChoice,
  chatTools,
  geminiMessages,
  geminiToolConfig,
  geminiTools,
  newCallId,
  type Msg,
} from "./wire.js";
import {
  FunnelError,
  type ApiProviderId,
  type FunnelEvent,
  type Message,
  type ModelInfo,
  type OpenAIApi,
  type Provider,
  type RunInput,
  type ToolCall,
} from "../types.js";
import { streamResponses } from "./responses.js";
import { joinUrl } from "../util/url.js";

/** What a stream hands back besides events. */
export interface Turn {
  /** Replaces the plain answer text as the assistant message in history, for vendors that need more than text back. */
  assistant?: Msg;
}

/** Tools are sent unless the choice is `none` on a vendor that has no `none`. */
const toolsOf = (input: RunInput) => (input.tools?.length ? input.tools : undefined);

/** Settings for one vendor, passed as `createFunnel({ api: { anthropic: {...} } })`. */
export interface ApiVendorConfig {
  /** The API key. Falls back to `apiKeys`, then to the vendor's environment variable. */
  key?: string;
  /**
   * Where requests go, for a gateway or an enterprise proxy. Written like the vendor SDKs take it: the Anthropic
   * default is `https://api.anthropic.com`, OpenAI's is `https://api.openai.com/v1` and Gemini's is
   * `https://generativelanguage.googleapis.com/v1beta`. cli-funnel adds the path after it.
   */
  baseUrl?: string;
  /** Sent with every request, after the default headers. A name that matches a default (any case) replaces it. */
  headers?: Record<string, string>;
  /** Extra attempts after a 429 or 5xx before any output. Default 2. 0 turns retries off. */
  retries?: number;
  /** First retry wait in milliseconds, doubled for each retry. Default 500. A `Retry-After` header wins. */
  retryDelayMs?: number;
  /**
   * OpenAI only: the API every run uses. Default: Chat Completions for models that take it, and Responses for the
   * models that only Responses serves (`-pro`, `-codex`). With Responses the conversation lives on OpenAI's side.
   */
  mode?: OpenAIApi;
}

export interface ApiConfig {
  anthropic?: ApiVendorConfig;
  openai?: ApiVendorConfig;
  gemini?: ApiVendorConfig;
}

/** What a vendor call needs besides the run input. */
interface ApiContext {
  baseUrl: string;
  /** Auth and version headers plus the configured extras, with lowercase names. */
  headers: Record<string, string>;
  retry: RetryOptions;
}

interface ApiSpec {
  id: ApiProviderId;
  displayName: string;
  envVar: string;
  keyHint: string;
  defaultBaseUrl: string;
  /** Prompt caching options the vendor takes. */
  cache: boolean;
  /** The headers that carry the key. */
  authHeaders(key: string): Record<string, string>;
  listModels(ctx: ApiContext): Promise<ModelInfo[]>;
  stream(ctx: ApiContext, input: RunInput, messages: Msg[], turn: Turn): AsyncGenerator<FunnelEvent>;
  /** Typed messages in this vendor's message format. `earlier` is the stored history, for tool call lookups. */
  toMessages(messages: Message[], input: RunInput, earlier: Msg[]): Msg[];
  /** A run whose conversation the vendor keeps, without local history. Undefined runs the usual way. */
  ownRun?(input: RunInput, config: ApiVendorConfig): ((ctx: ApiContext) => AsyncIterable<FunnelEvent>) | undefined;
}

const MODEL_BASE = { contextWindows: [], fast: false, source: "cli" as const };

const EPHEMERAL = { type: "ephemeral" };

/** A copy of the last message with a cache breakpoint on its last content block. Stored history stays untouched. */
function cacheLast(messages: Msg[]): Msg[] {
  const last = messages.at(-1);
  if (!last) return messages;
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...(last.content ?? [])];
  blocks[blocks.length - 1] = { ...(blocks.at(-1) as object), cache_control: EPHEMERAL };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

/** The Messages request body. */
export function anthropicBody(input: RunInput, messages: Msg[]): Record<string, unknown> {
  const { effort, model } = input.selection;
  const { sampling } = input;
  const outputConfig = {
    ...(effort ? { effort } : {}),
    ...(input.responseSchema ? { format: { type: "json_schema", schema: input.responseSchema.schema } } : {}),
  };
  return {
    model,
    max_tokens: input.maxOutputTokens ?? 8192,
    stream: true,
    ...(input.system ? { system: input.cache ? [{ type: "text", text: input.system, cache_control: EPHEMERAL }] : input.system } : {}),
    // The newest models hide thinking text unless `display` asks for it. Effort turns thinking on where it is off by default.
    ...(effort && anthropicAdaptive(model) ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
    ...(sampling?.topP !== undefined ? { top_p: sampling.topP } : {}),
    ...(sampling?.stop?.length ? { stop_sequences: sampling.stop } : {}),
    ...(toolsOf(input) ? { tools: anthropicTools(input.tools!) } : {}),
    ...(input.toolChoice ? { tool_choice: anthropicToolChoice(input.toolChoice) } : {}),
    messages: input.cache ? cacheLast(messages) : messages,
  };
}

const anthropic: ApiSpec = {
  id: "anthropic-api",
  displayName: "Anthropic API",
  envVar: "ANTHROPIC_API_KEY",
  keyHint: "console.anthropic.com",
  defaultBaseUrl: "https://api.anthropic.com",
  cache: true,
  authHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  async listModels(ctx) {
    const out: ModelInfo[] = [];
    let after = "";
    // The list is short today, but it is paged, so follow `has_more`. The cap stops a server that never ends.
    for (let page = 0; page < 20; page++) {
      const res = await fetch(joinUrl(ctx.baseUrl, `/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`), { headers: ctx.headers });
      if (!res.ok) throw new FunnelError(`Anthropic API returned ${res.status}.`, "cli-failed");
      const body = (await res.json()) as { data: { id: string; display_name?: string }[]; has_more?: boolean; last_id?: string };
      for (const m of body.data) out.push({ id: m.id, name: m.display_name ?? m.id, provider: "anthropic-api", efforts: anthropicEfforts(m.id), ...MODEL_BASE });
      if (!body.has_more || !body.last_id) break;
      after = body.last_id;
    }
    return out;
  },
  async *stream(ctx, input, messages, turn) {
    const res = yield* fetchRetrying(
      joinUrl(ctx.baseUrl, "/v1/messages"),
      { method: "POST", signal: input.signal, headers: { ...ctx.headers, "content-type": "application/json" }, body: JSON.stringify(anthropicBody(input, messages)) },
      ctx.retry,
    );
    if (!res.ok) return yield* httpError("Anthropic API", res);
    let inTok = 0;
    let outTok = 0;
    let cached = 0;
    let created = 0;
    let stop = "end_turn";
    let stopped = false;
    // The content blocks of the answer by index. A turn with tool calls goes back whole, thinking signatures included,
    // because the API wants the thinking that led to a tool call next to its result.
    const blocks: Record<string, any>[] = [];
    const calls: ToolCall[] = [];
    for await (const { data } of readSSE(res)) {
      const e = JSON.parse(data);
      const block = typeof e.index === "number" ? blocks[e.index] : undefined;
      if (e.type === "message_start") {
        inTok = e.message.usage?.input_tokens ?? 0;
        cached = e.message.usage?.cache_read_input_tokens ?? 0;
        created = e.message.usage?.cache_creation_input_tokens ?? 0;
      } else if (e.type === "content_block_start" && typeof e.index === "number") {
        blocks[e.index] = { ...e.content_block, ...(e.content_block?.type === "tool_use" ? { json: "" } : {}) };
      } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        if (block) block.text = (block.text ?? "") + e.delta.text;
        yield { type: "text.delta", text: e.delta.text };
      }
      // With display "omitted" the deltas carry an empty string.
      else if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta") {
        if (block) block.thinking = (block.thinking ?? "") + e.delta.thinking;
        if (e.delta.thinking) yield { type: "reasoning.delta", text: e.delta.thinking };
      } else if (e.type === "content_block_delta" && e.delta?.type === "signature_delta") {
        if (block) block.signature = (block.signature ?? "") + e.delta.signature;
      } else if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta" && block?.type === "tool_use") {
        block.json += e.delta.partial_json ?? "";
        if (e.delta.partial_json) yield { type: "tool_call.delta", id: block.id, name: block.name, arguments: e.delta.partial_json };
      } else if (e.type === "content_block_stop" && block?.type === "tool_use") {
        const call = { id: String(block.id), name: String(block.name), input: parseArguments(block.json) };
        block.input = call.input && typeof call.input === "object" ? call.input : {};
        delete block.json;
        calls.push(call);
        yield { type: "tool_call", ...call };
      } else if (e.type === "message_delta") {
        outTok = e.usage?.output_tokens ?? outTok;
        stop = e.delta?.stop_reason ?? stop;
      } else if (e.type === "message_stop") stopped = true;
      else if (e.type === "error") return yield { type: "error", message: e.error?.message ?? "API error" };
    }
    if (!stopped) return yield truncated("Anthropic API");
    // Empty text blocks are refused when sent back.
    if (calls.length) turn.assistant = { role: "assistant", content: blocks.filter((b) => b && !(b.type === "text" && !b.text)) };
    // Cache reads and writes are input tokens the model processed, as in the Claude Code parser.
    const inputTokens = inTok + cached + created;
    yield {
      type: "usage",
      usage: { inputTokens, outputTokens: outTok, cachedInputTokens: cached, cacheCreationInputTokens: created, totalTokens: inputTokens + outTok },
    };
    yield {
      type: "done",
      text: "",
      finishReason:
        stop === "refusal" ? "denied" : stop === "max_tokens" || stop === "model_context_window_exceeded" ? "length" : calls.length ? "tool_calls" : "stop",
    };
  },
  toMessages: (messages) => anthropicMessages(messages),
};

export interface ChatCompletionsOptions {
  /** Base URL that ends before `/chat/completions`, for example `https://api.openai.com/v1`. */
  baseUrl: string;
  key?: string;
  /** Extra headers, sent after the defaults. */
  headers?: Record<string, string>;
  retry?: RetryOptions;
  /** Name of the output limit field. OpenAI uses `max_completion_tokens`, most other servers `max_tokens`. */
  maxTokensField: "max_completion_tokens" | "max_tokens";
  /** Prefix for error messages, for example "OpenAI API". */
  label: string;
  /** Send `strict: true` with the JSON schema, so the server enforces it. Only OpenAI is known to take it everywhere. */
  strictSchema?: boolean;
}

/**
 * Streams one Chat Completions turn. Shared by `openai-api` and the OpenAI-compatible endpoints. `turn.assistant` gets
 * the answer with its tool calls, for the session history.
 */
export async function* streamChatCompletions(opts: ChatCompletionsOptions, input: RunInput, messages: Msg[], turn: Turn = {}): AsyncGenerator<FunnelEvent> {
  let res: Response;
  try {
    res = yield* fetchRetrying(
      joinUrl(opts.baseUrl, "/chat/completions"),
      {
        method: "POST",
        signal: input.signal,
        headers: jsonHeaders(opts.key, opts.headers),
        body: JSON.stringify({
          model: input.selection.model,
          // The system message is sent on every call and never stored in the session history.
          messages: input.system ? [{ role: "system", content: input.system }, ...messages] : messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(input.maxOutputTokens ? { [opts.maxTokensField]: input.maxOutputTokens } : {}),
          ...(input.selection.effort ? { reasoning_effort: input.selection.effort } : {}),
          ...(input.sampling?.temperature !== undefined ? { temperature: input.sampling.temperature } : {}),
          ...(input.sampling?.topP !== undefined ? { top_p: input.sampling.topP } : {}),
          ...(input.sampling?.stop?.length ? { stop: input.sampling.stop } : {}),
          ...(input.sampling?.seed !== undefined ? { seed: input.sampling.seed } : {}),
          ...(input.responseSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: { name: input.responseSchema.name ?? "response", schema: input.responseSchema.schema, ...(opts.strictSchema ? { strict: true } : {}) },
                },
              }
            : {}),
          ...(toolsOf(input) ? { tools: chatTools(input.tools!) } : {}),
          ...(input.toolChoice ? { tool_choice: chatToolChoice(input.toolChoice) } : {}),
        }),
      },
      opts.retry,
    );
  } catch (err) {
    if (input.signal?.aborted) return yield { type: "done", text: "", finishReason: "cancelled" };
    return yield { type: "error", message: `${opts.label} is not reachable at ${opts.baseUrl}: ${String(err)}`, code: "cli-failed" };
  }
  let usage:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      }
    | undefined;
  let stop = "stop";
  let finished = false;
  let text = "";
  const tools = chatToolCalls();
  try {
    // The error body is read inside the try, so an abort while reading it ends the run as cancelled.
    if (!res.ok) return yield* httpError(opts.label, res);
    for await (const { data } of readSSE(res)) {
      if (data === "[DONE]") {
        finished = true;
        break;
      }
      const e = JSON.parse(data);
      if (e.error) return yield { type: "error", message: String(e.error.message ?? e.error), code: "cli-failed" };
      const choice = e.choices?.[0];
      // Servers name the reasoning field differently: vLLM, llama.cpp and LM Studio use reasoning_content, Ollama uses reasoning.
      const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
      if (typeof reasoning === "string" && reasoning) yield { type: "reasoning.delta", text: reasoning };
      if (choice?.delta?.content) {
        text += choice.delta.content;
        yield { type: "text.delta", text: choice.delta.content };
      }
      yield* tools.add(choice?.delta?.tool_calls);
      // A refusal streams in its own field instead of `content`.
      if (choice?.delta?.refusal) {
        yield { type: "text.delta", text: choice.delta.refusal };
        stop = "refusal";
      }
      if (choice?.finish_reason) {
        if (stop !== "refusal") stop = choice.finish_reason;
        finished = true;
      }
      if (e.usage) usage = e.usage;
    }
  } catch (err) {
    if (input.signal?.aborted) return yield { type: "done", text: "", finishReason: "cancelled" };
    throw err;
  }
  if (!finished) return yield truncated(opts.label);
  const calls = tools.finish();
  for (const call of calls) yield { type: "tool_call", ...call };
  turn.assistant = chatAssistant(text, calls);
  if (usage) {
    const cached = usage.prompt_tokens_details?.cached_tokens;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens;
    yield {
      type: "usage",
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
        ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
        totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
      },
    };
  }
  yield {
    type: "done",
    text: "",
    finishReason: stop === "content_filter" || stop === "refusal" ? "denied" : stop === "length" ? "length" : calls.length ? "tool_calls" : "stop",
  };
}

/**
 * True for ids that Chat Completions takes. Drops models without text chat, Responses-only models (`-pro`, `-codex`,
 * deep research, computer use) and aliases (`chatgpt-*`, `*-latest`). Fine-tunes (`ft:<base>:...`) are judged by their base.
 */
export function openaiChatModel(id: string): boolean {
  const base = id.startsWith("ft:") ? id.slice(3).split(":")[0]! : id;
  if (!/^(gpt-|o\d)/.test(base)) return false;
  if (!id.startsWith("ft:") && /-latest$/.test(id)) return false;
  return !/(audio|realtime|tts|transcribe|image|search|embedding|moderation|instruct|codex|deep-research|computer-use|-pro(-|$))/.test(base);
}

/**
 * The OpenAI APIs a model id works with. Chat models work with both. `-pro` and `-codex` models work only with
 * Responses. Deep research, computer use, aliases and models without text chat get none.
 */
export function openaiApis(id: string): OpenAIApi[] {
  if (openaiChatModel(id)) return ["chat", "responses"];
  if (!/^(gpt-|o\d)/.test(id) || /-latest$/.test(id)) return [];
  if (/(audio|realtime|tts|transcribe|image|search|embedding|moderation|instruct|deep-research|computer-use)/.test(id)) return [];
  return /(codex|-pro(-|$))/.test(id) ? ["responses"] : [];
}

/** The API a run uses: the configured mode, else Chat Completions when the model takes it, else Responses. */
const openaiApiFor = (model: string, mode?: OpenAIApi): OpenAIApi => mode ?? (openaiApis(model)[0] ?? "chat");

const openai: ApiSpec = {
  id: "openai-api",
  displayName: "OpenAI API",
  envVar: "OPENAI_API_KEY",
  keyHint: "platform.openai.com",
  defaultBaseUrl: "https://api.openai.com/v1",
  cache: false,
  authHeaders: (key) => bearer(key),
  async listModels(ctx) {
    const res = await fetch(joinUrl(ctx.baseUrl, "/models"), { headers: ctx.headers });
    if (!res.ok) throw new FunnelError(`OpenAI API returned ${res.status}.`, "cli-failed");
    const body = (await res.json()) as { data: { id: string }[] };
    const models = body.data.flatMap((m) => {
      const apis = openaiApis(m.id);
      return apis.length ? [{ id: m.id, name: m.id, provider: "openai-api" as const, efforts: openaiEfforts(m.id), apis, ...MODEL_BASE }] : [];
    });
    return models.sort((a, b) => a.id.localeCompare(b.id));
  },
  // The key is already in ctx.headers, so it is passed as a header and not as `key`.
  stream: (ctx, input, messages, turn) =>
    streamChatCompletions({ baseUrl: ctx.baseUrl, headers: ctx.headers, retry: ctx.retry, maxTokensField: "max_completion_tokens", label: "OpenAI API", strictSchema: true }, input, messages, turn),
  toMessages: chatMessages,
  ownRun: (input, config) =>
    openaiApiFor(input.selection.model, config.mode) === "responses"
      ? (ctx) => streamResponses({ baseUrl: ctx.baseUrl, headers: ctx.headers, retry: ctx.retry, label: "OpenAI API", strictSchema: true }, input)
      : undefined,
};

/** Gemini ids that are aliases or models without text chat. Aliases like `gemini-flash-latest` break the versioned-id rule. */
const GEMINI_SKIP = /latest|embedding|aqa|tts|image|imagen|veo|live|audio|robotics|computer-use/;

/** Finish reasons where the run failed rather than ended. */
const GEMINI_FAILED = new Set(["MALFORMED_FUNCTION_CALL", "OTHER"]);

/** Finish reasons where Gemini withheld or cut the answer for policy reasons. */
const GEMINI_BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

const gemini: ApiSpec = {
  id: "gemini-api",
  displayName: "Gemini API",
  envVar: "GEMINI_API_KEY",
  keyHint: "aistudio.google.com",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  cache: true,
  authHeaders: (key) => ({ "x-goog-api-key": key }),
  async listModels(ctx) {
    const out: ModelInfo[] = [];
    let page = "";
    do {
      const res = await fetch(joinUrl(ctx.baseUrl, `/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`), {
        headers: ctx.headers,
      });
      if (!res.ok) throw new FunnelError(`Gemini API returned ${res.status}.`, "cli-failed");
      const body = (await res.json()) as {
        models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
        nextPageToken?: string;
      };
      for (const m of body.models ?? []) {
        const id = m.name.replace(/^models\//, "");
        if (!m.supportedGenerationMethods?.includes("generateContent") || GEMINI_SKIP.test(id)) continue;
        out.push({ id, name: m.displayName ?? id, provider: "gemini-api", efforts: geminiEfforts(id), ...MODEL_BASE });
      }
      page = body.nextPageToken ?? "";
    } while (page);
    return out.sort((a, b) => a.id.localeCompare(b.id));
  },
  async *stream(ctx, input, messages, turn) {
    const res = yield* fetchRetrying(
      joinUrl(ctx.baseUrl, `/models/${encodeURIComponent(input.selection.model)}:streamGenerateContent?alt=sse`),
      {
        method: "POST",
        signal: input.signal,
        headers: { ...ctx.headers, "content-type": "application/json" },
        body: JSON.stringify({
          contents: messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: typeof m.content === "string" ? [{ text: m.content }] : m.content,
          })),
          ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
          ...(input.cachedContent ? { cachedContent: input.cachedContent } : {}),
          generationConfig: {
            ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
            ...(input.selection.effort ? { thinkingConfig: { thinkingLevel: input.selection.effort, includeThoughts: true } } : {}),
            ...(input.sampling?.temperature !== undefined ? { temperature: input.sampling.temperature } : {}),
            ...(input.sampling?.topP !== undefined ? { topP: input.sampling.topP } : {}),
            ...(input.sampling?.stop?.length ? { stopSequences: input.sampling.stop } : {}),
            ...(input.sampling?.seed !== undefined ? { seed: input.sampling.seed } : {}),
            ...(input.responseSchema ? { responseMimeType: "application/json", responseJsonSchema: input.responseSchema.schema } : {}),
          },
          ...(toolsOf(input) ? { tools: geminiTools(input.tools!) } : {}),
          ...(input.toolChoice ? { toolConfig: geminiToolConfig(input.toolChoice) } : {}),
        }),
      },
      ctx.retry,
    );
    if (!res.ok) return yield* httpError("Gemini API", res);
    let usage: Record<string, number> | undefined;
    let stop = "STOP";
    let finished = false;
    // The whole answer, so `thoughtSignature` goes back with the next turn. Adjacent plain text parts are joined.
    const parts: Record<string, unknown>[] = [];
    let called = false;
    for await (const { data } of readSSE(res)) {
      const e = JSON.parse(data);
      if (e.error) return yield { type: "error", message: e.error.message ?? "Gemini API error" };
      if (e.promptFeedback?.blockReason) {
        stop = "SAFETY";
        finished = true;
      }
      const candidate = e.candidates?.[0];
      for (const raw of candidate?.content?.parts ?? []) {
        let part = raw;
        // Gemini sends each call whole. It may leave out the id, so one is made up and kept in history, where a
        // later tool result finds the call's name by it.
        if (raw.functionCall) {
          const id = raw.functionCall.id || newCallId();
          part = { ...raw, functionCall: { ...raw.functionCall, id } };
          called = true;
          yield { type: "tool_call", id, name: String(raw.functionCall.name), input: raw.functionCall.args ?? {} };
        }
        // Thought summaries are not sent back, but a signature on one must be.
        if (!part.thought || part.thoughtSignature) {
          const last = parts[parts.length - 1];
          const plain = (p: Record<string, unknown>) => Object.keys(p).every((k) => k === "text");
          if (last && typeof part.text === "string" && plain(part) && plain(last)) last.text = String(last.text) + part.text;
          else parts.push({ ...part });
        }
        if (typeof part.text !== "string" || !part.text) continue;
        yield part.thought ? { type: "reasoning.delta", text: part.text } : { type: "text.delta", text: part.text };
      }
      if (candidate?.finishReason) {
        stop = candidate.finishReason;
        finished = true;
      }
      if (e.usageMetadata) usage = e.usageMetadata;
    }
    if (!finished) return yield truncated("Gemini API");
    if (parts.length) turn.assistant = { role: "assistant", content: parts };
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
    if (GEMINI_FAILED.has(stop)) return yield { type: "error", message: `Gemini API stopped with ${stop}.`, code: "cli-failed" };
    yield { type: "done", text: "", finishReason: GEMINI_BLOCKED.has(stop) ? "denied" : stop === "MAX_TOKENS" ? "length" : called ? "tool_calls" : "stop" };
  },
  toMessages: (messages, input, earlier) => geminiMessages(messages, input.selection.model, earlier),
};

/** Turns an aborted fetch into a cancelled run and a network failure into an error event, as the other providers do. */
async function* settle(spec: ApiSpec, input: RunInput, stream: () => AsyncIterable<FunnelEvent>): AsyncGenerator<FunnelEvent> {
  try {
    yield* stream();
  } catch (err) {
    if (input.signal?.aborted) return yield { type: "done", text: "", finishReason: "cancelled" };
    const code = err instanceof FunnelError ? err.code : "cli-failed";
    yield { type: "error", message: `${spec.displayName}: ${err instanceof Error ? err.message : String(err)}`, code };
  }
}

function makeApiProvider(spec: ApiSpec, getKey: () => string | undefined, config: ApiVendorConfig = {}): Provider {
  // A gateway that authenticates through its own headers needs no key.
  const hasHeaders = !!config.headers && Object.keys(config.headers).length > 0;
  const context = (): ApiContext => {
    const k = getKey() ?? process.env[spec.envVar];
    if (!k && !hasHeaders) {
      throw new FunnelError(`Set ${spec.envVar} (get a key at ${spec.keyHint}) or pass it to createFunnel({ apiKeys }).`, "not-logged-in");
    }
    return {
      baseUrl: (config.baseUrl ?? spec.defaultBaseUrl).trim().replace(/\/+$/, ""),
      headers: mergeHeaders(k ? spec.authHeaders(k) : {}, config.headers),
      retry: { retries: config.retries, retryDelayMs: config.retryDelayMs },
    };
  };
  return {
    id: spec.id,
    displayName: spec.displayName,
    capabilities: httpCapabilities({ cache: spec.cache }),
    detect: async () => ({ installed: true, testedRange: { min: "0" }, withinTestedRange: true }),
    authStatus: async () => {
      const hasKey = !!(getKey() ?? process.env[spec.envVar]);
      return { loggedIn: hasKey || hasHeaders, method: hasKey ? "API key" : "Headers" };
    },
    ...httpAccount({
      login: `${spec.displayName} uses an API key. Set ${spec.envVar}.`,
      logout: `Remove ${spec.envVar} from your environment to sign out.`,
      update: "API providers have nothing to update.",
    }),
    models: async () => spec.listModels(context()),
    run(input) {
      const secrets = [getKey() ?? process.env[spec.envVar], ...Object.values(config.headers ?? {})];
      const own = spec.ownRun?.(input, config);
      if (own) return redactErrors(settle(spec, input, () => own(context())), secrets);
      const turn: Turn = {};
      return redactErrors(
        runWithHistory<Msg>(input, (messages, earlier) => spec.toMessages(messages, input, earlier), (text): Msg => turn.assistant ?? { role: "assistant", content: text }, (messages) =>
          settle(spec, input, () => spec.stream(context(), input, messages, turn)),
        ),
        secrets,
      );
    },
  };
}

export interface ApiKeys {
  anthropic?: string;
  openai?: string;
  gemini?: string;
}

/** Keys in `config` win over `keys`. Both fall back to the vendor's environment variable. */
export const createApiProviders = (keys: ApiKeys = {}, config: ApiConfig = {}): Record<ApiProviderId, Provider> => ({
  "anthropic-api": makeApiProvider(anthropic, () => config.anthropic?.key ?? keys.anthropic, config.anthropic),
  "openai-api": makeApiProvider(openai, () => config.openai?.key ?? keys.openai, config.openai),
  "gemini-api": makeApiProvider(gemini, () => config.gemini?.key ?? keys.gemini, config.gemini),
});
