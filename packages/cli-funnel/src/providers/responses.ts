import { parseArguments, pendingMessages, runMessages } from "../messages.js";
import { readSSE } from "../util/sse.js";
import { fetchRetrying, httpError, jsonHeaders, truncated, type RetryOptions } from "./http.js";
import { responsesInput, responsesToolChoice, responsesTools } from "./wire.js";
import type { FinishReason, FunnelEvent, RunInput, Usage } from "../types.js";
import { joinUrl } from "../util/url.js";

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
      joinUrl(opts.baseUrl, "/responses"),
      {
        method: "POST",
        signal: input.signal,
        headers: jsonHeaders(opts.key, opts.headers),
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
      return yield* httpError(opts.label, res);
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
  yield truncated(opts.label);
}
