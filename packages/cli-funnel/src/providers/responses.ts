import { parseArguments, pendingMessages, runMessages, stringifyArguments } from "../messages.js";
import { readSSE } from "../util/sse.js";
import { fetchRetrying, mergeHeaders, type RetryOptions } from "./http.js";
import { parseHttpLimit } from "./limits.js";
import type { ContentPart, FinishReason, FunnelEvent, Message, RunInput, ToolChoice, ToolDefinition, Usage } from "../types.js";

/**
 * The OpenAI Responses API: `POST /responses` with streaming events. Used by `openai-api` for models that only it
 * serves, or for every model with `mode: "responses"`, and by OpenAI-compatible endpoints that opt in. The session
 * lives on the server: the session id is the id of the last response, sent back as `previous_response_id`.
 */

export interface ResponsesOptions {
  /** Base URL that ends before `/responses`, for example `https://api.openai.com/v1`. */
  baseUrl: string;
  key?: string;
  headers?: Record<string, string>;
  retry?: RetryOptions;
  /** Prefix for error messages, for example "OpenAI API". */
  label: string;
  /** Send `strict: true` with the JSON schema. */
  strictSchema?: boolean;
}

const NO_PARAMETERS = { type: "object", properties: {} };

export const responsesTools = (tools: ToolDefinition[]) =>
  tools.map((t) => ({ type: "function", name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters ?? NO_PARAMETERS }));

export const responsesToolChoice = (c: ToolChoice) => (typeof c === "string" ? c : { type: "function", name: c.name });

const userPart = (p: ContentPart) =>
  p.type === "image" ? { type: "input_image", image_url: `data:${p.mediaType};base64,${p.data}` } : { type: "input_text", text: p.type === "text" ? p.text : "" };

/** Typed messages as Responses input items. Tool calls and their results are items of their own, not message content. */
export function responsesInput(messages: Message[]): Record<string, unknown>[] {
  return messages.flatMap((m) => {
    if (typeof m.content === "string") return [{ role: m.role, content: m.content }];
    const items: Record<string, unknown>[] = [];
    const rest: ContentPart[] = [];
    for (const p of m.content) {
      if (p.type === "tool_call") items.push({ type: "function_call", call_id: p.id, name: p.name, arguments: stringifyArguments(p.input) });
      else if (p.type === "tool_result") items.push({ type: "function_call_output", call_id: p.toolCallId, output: p.isError ? `Error: ${p.output}` : p.output });
      else rest.push(p);
    }
    if (!rest.length) return items;
    const message =
      m.role === "assistant"
        ? { role: "assistant", content: rest.map((p) => (p.type === "text" ? p.text : "")).join("") }
        : { role: "user", content: rest.map(userPart) };
    // A tool result answers the call before it, so results go first; an assistant's text comes before its calls.
    return m.role === "assistant" ? [message, ...items] : [...items, message];
  });
}

/** The request body. With a session only the new messages go, since the server holds the rest. */
export function responsesBody(input: RunInput, strictSchema = false): Record<string, unknown> {
  const all = runMessages(input);
  const { sampling, selection } = input;
  return {
    model: selection.model,
    input: responsesInput(input.sessionId ? pendingMessages(all) : all),
    stream: true,
    // Instructions do not carry over through previous_response_id, so they go with every turn.
    ...(input.system ? { instructions: input.system } : {}),
    ...(input.sessionId ? { previous_response_id: input.sessionId } : {}),
    ...(input.maxOutputTokens ? { max_output_tokens: input.maxOutputTokens } : {}),
    ...(selection.effort ? { reasoning: { effort: selection.effort, summary: "auto" } } : {}),
    ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
    ...(sampling?.topP !== undefined ? { top_p: sampling.topP } : {}),
    ...(input.responseSchema
      ? { text: { format: { type: "json_schema", name: input.responseSchema.name ?? "response", schema: input.responseSchema.schema, ...(strictSchema ? { strict: true } : {}) } } }
      : {}),
    ...(input.tools?.length ? { tools: responsesTools(input.tools) } : {}),
    ...(input.toolChoice ? { tool_choice: responsesToolChoice(input.toolChoice) } : {}),
  };
}

type Json = Record<string, any>;

function toUsage(u: Json | undefined): Usage | undefined {
  if (!u) return undefined;
  const cached = u.input_tokens_details?.cached_tokens;
  const reasoning = u.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    totalTokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
  };
}

/**
 * Folds Responses stream events into funnel events. A pure function of the events, so it is tested on fixtures.
 * `finished` turns true at `response.completed`, `response.incomplete`, `response.failed` or `error`.
 */
export function responsesEvents() {
  // Function call items by item id, so argument deltas can name their call.
  const calls = new Map<string, { callId: string; name: string }>();
  let refused = false;
  let called = false;
  let summaryParts = 0;
  const state = {
    finished: false,
    add(e: Json): FunnelEvent[] {
      switch (e.type) {
        case "response.created":
          return typeof e.response?.id === "string" ? [{ type: "session", sessionId: e.response.id, ...(e.response.model ? { model: e.response.model } : {}) }] : [];
        case "response.output_text.delta":
          return e.delta ? [{ type: "text.delta", text: e.delta }] : [];
        case "response.refusal.delta":
          refused = true;
          return e.delta ? [{ type: "text.delta", text: e.delta }] : [];
        case "response.reasoning_summary_part.added":
          // Summary parts are paragraphs. A blank line keeps them apart in the joined text.
          return summaryParts++ > 0 ? [{ type: "reasoning.delta", text: "\n\n" }] : [];
        case "response.reasoning_summary_text.delta":
          return e.delta ? [{ type: "reasoning.delta", text: e.delta }] : [];
        case "response.output_item.added":
          if (e.item?.type === "function_call") calls.set(e.item.id, { callId: e.item.call_id, name: e.item.name });
          return [];
        case "response.function_call_arguments.delta": {
          const call = calls.get(e.item_id);
          return call && e.delta ? [{ type: "tool_call.delta", id: call.callId, name: call.name, arguments: e.delta }] : [];
        }
        case "response.output_item.done":
          if (e.item?.type !== "function_call") return [];
          called = true;
          return [{ type: "tool_call", id: e.item.call_id, name: e.item.name, input: parseArguments(e.item.arguments ?? "") }];
        case "response.completed":
        case "response.incomplete": {
          state.finished = true;
          const reason = e.response?.incomplete_details?.reason;
          const finishReason: FinishReason =
            reason === "max_output_tokens" ? "length" : reason === "content_filter" || refused ? "denied" : called ? "tool_calls" : "stop";
          const usage = toUsage(e.response?.usage);
          return [...(usage ? [{ type: "usage" as const, usage }] : []), { type: "done", text: "", finishReason }];
        }
        case "response.failed":
          state.finished = true;
          return [{ type: "error", message: String(e.response?.error?.message ?? "The response failed."), code: "cli-failed" }];
        case "error":
          state.finished = true;
          return [{ type: "error", message: String(e.message ?? e.error?.message ?? "API error"), code: "cli-failed" }];
        default:
          return [];
      }
    },
  };
  return state;
}

/** Streams one Responses turn. The `session` event carries the new response id, which continues the conversation. */
export async function* streamResponses(opts: ResponsesOptions, input: RunInput): AsyncGenerator<FunnelEvent> {
  const cancelled: FunnelEvent = { type: "done", text: "", finishReason: "cancelled" };
  let res: Response;
  try {
    res = yield* fetchRetrying(
      `${opts.baseUrl}/responses`,
      {
        method: "POST",
        signal: input.signal,
        headers: mergeHeaders({ ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), "content-type": "application/json" }, opts.headers),
        body: JSON.stringify(responsesBody(input, opts.strictSchema)),
      },
      opts.retry,
    );
  } catch (err) {
    if (input.signal?.aborted) return yield cancelled;
    return yield { type: "error", message: `${opts.label} is not reachable at ${opts.baseUrl}: ${String(err)}`, code: "cli-failed" };
  }
  const fold = responsesEvents();
  try {
    if (!res.ok) {
      // A 429 comes with a `limit` event first, as on the other API providers.
      const text = await res.text();
      const limit = parseHttpLimit(res.status, res.headers, text);
      if (limit) yield limit;
      return yield { type: "error", message: `${opts.label} ${res.status}: ${text}`, code: "cli-failed" };
    }
    for await (const { data } of readSSE(res)) {
      if (data === "[DONE]") break;
      yield* fold.add(JSON.parse(data));
      if (fold.finished) return;
    }
  } catch (err) {
    if (input.signal?.aborted) return yield cancelled;
    throw err;
  }
  yield { type: "error", message: `${opts.label} closed the stream before the answer finished.`, code: "stream-truncated" };
}
