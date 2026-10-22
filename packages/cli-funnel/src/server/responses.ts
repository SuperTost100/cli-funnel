import { randomUUID } from "node:crypto";
import type { Funnel } from "../funnel.js";
import { parseArguments, stringifyArguments } from "../messages.js";
import {
  type AccessLevel,
  type ContentPart,
  type ProviderOptions,
  type Message,
  type RunRequest,
  type RunResult,
  type Usage,
} from "../types.js";
import { isObject } from "../util/is-object.js";
import { readJson } from "./body.js";
import { resolveSelection, samplingOptions, type OpenAIDefaults } from "./openai.js";
import { SYSTEM_ROLES, answerOf, errorResponse, fail, failure, imagePart, notFound, pullFirst, pushToolResult, runSlot, toolOptions, tracked, type TrackedRun } from "./shared.js";
import { json, sse, sseHeaders } from "./sse.js";

/**
 * `POST /v1/responses`: the OpenAI Responses API in front of any provider. The request becomes a run the same way
 * `/v1/chat/completions` does. The response id is the run's session id, so a client that sends it back as
 * `previous_response_id` continues the conversation, whatever keeps it: the CLI, the funnel's history or OpenAI.
 */

type Json = Record<string, unknown>;
type Problem = { message: string; param: string };

const TEXT_PARTS = new Set(["input_text", "output_text", "text"]);

/** Input items as typed messages plus the system text found in them. Returns the problem when an item cannot be mapped. */
export function inputToMessages(input: unknown): { messages: Message[]; system: string[] } | Problem {
  if (typeof input === "string") return { messages: [{ role: "user", content: input }], system: [] };
  if (!Array.isArray(input) || input.length === 0) return { message: "input must be a string or a non-empty array of items.", param: "input" };
  const messages: Message[] = [];
  const system: string[] = [];
  for (const [i, raw] of input.entries()) {
    const at = `input[${i}]`;
    if (!isObject(raw)) return { message: `${at} must be an object.`, param: at };
    const type = raw.type ?? "message";
    if (type === "reasoning") continue;
    if (type === "function_call") {
      if (typeof raw.call_id !== "string" || typeof raw.name !== "string") return { message: `${at} needs a call_id and a name.`, param: at };
      // Calls join the assistant message before them.
      const call: ContentPart = { type: "tool_call", id: raw.call_id, name: raw.name, input: parseArguments(typeof raw.arguments === "string" ? raw.arguments : "") };
      const last = messages.at(-1);
      if (last?.role === "assistant" && Array.isArray(last.content)) last.content.push(call);
      else messages.push({ role: "assistant", content: [call] });
      continue;
    }
    if (type === "function_call_output") {
      if (typeof raw.call_id !== "string") return { message: `${at} needs a call_id.`, param: at };
      const output = typeof raw.output === "string" ? raw.output : Array.isArray(raw.output) ? raw.output.map((p) => (isObject(p) && typeof p.text === "string" ? p.text : "")).join("") : "";
      pushToolResult(messages, { type: "tool_result", toolCallId: raw.call_id, output });
      continue;
    }
    if (type !== "message") return { message: `${at}: item type "${String(type)}" is not supported.`, param: at };
    const role = String(raw.role);
    const content = raw.content;
    const parts: ContentPart[] = [];
    if (typeof content === "string") parts.push({ type: "text", text: content });
    else if (Array.isArray(content)) {
      for (const [j, p] of content.entries()) {
        const param = `${at}.content[${j}]`;
        if (!isObject(p)) return { message: `${param} must be an object.`, param };
        if (TEXT_PARTS.has(String(p.type))) parts.push({ type: "text", text: typeof p.text === "string" ? p.text : "" });
        else if (p.type === "input_image" && role === "user") {
          const image = imagePart(typeof p.image_url === "string" ? p.image_url : "");
          if (!image) return { message: `${param}: images must be base64 data URLs of png, jpeg, webp or gif.`, param };
          parts.push(image);
        } else if (p.type !== "refusal") return { message: `${param}: content part "${String(p.type)}" is not supported here.`, param };
      }
    } else return { message: `${at}.content must be a string or an array of parts.`, param: `${at}.content` };
    if (SYSTEM_ROLES.has(role)) system.push(parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
    else if (role === "user" || role === "assistant") messages.push({ role, content: typeof content === "string" ? content : parts });
    else return { message: `${at}.role "${role}" is not supported.`, param: `${at}.role` };
  }
  return { messages, system };
}

/** The function of a Responses tool or tool_choice, which is the item itself. Hosted tools such as web search have no provider here. */
const functionOf = (v: unknown) => (isObject(v) && v.type === "function" ? v : undefined);

/** Fields this endpoint cannot honour. A client that sets one gets a 400 instead of an answer that ignored it. */
function unsupported(body: Json): string | undefined {
  const text = isObject(body.text) && isObject(body.text.format) ? body.text.format : undefined;
  const checks: [string, boolean][] = [
    ["background", body.background === true],
    ["conversation", body.conversation != null],
    ["prompt", body.prompt != null],
    ["text.format", text?.type === "json_object"],
  ];
  return checks.find(([, bad]) => bad)?.[0];
}

const usageOut = (u?: Usage) =>
  u
    ? {
        input_tokens: u.inputTokens,
        input_tokens_details: { cached_tokens: u.cachedInputTokens ?? 0 },
        output_tokens: u.outputTokens,
        output_tokens_details: { reasoning_tokens: u.reasoningTokens ?? 0 },
        total_tokens: u.totalTokens,
      }
    : null;

const incompleteReason = (r: RunResult["finishReason"]) => (r === "length" ? "max_output_tokens" : r === "denied" ? "content_filter" : undefined);

const callItem = (c: { id: string; name: string }, args: string, status: "in_progress" | "completed") => ({
  type: "function_call",
  id: `fc_${c.id}`,
  call_id: c.id,
  name: c.name,
  arguments: args,
  status,
});

export async function handleResponses(
  funnel: Funnel,
  req: Request,
  defaults: OpenAIDefaults,
  cwdAllowed: (cwd: string) => boolean,
  maxBodyBytes: number,
  startRun: (signal: AbortSignal) => TrackedRun,
): Promise<Response> {
  if (req.method !== "POST") return notFound();
  const body = await readJson(req, maxBodyBytes);
  if (typeof body.model !== "string" || !body.model) return fail(400, "model is required and must be a string.", { param: "model" });
  if (body.x_funnel !== undefined && !isObject(body.x_funnel)) return fail(400, "x_funnel must be an object.", { param: "x_funnel" });
  const x = (body.x_funnel ?? {}) as { cwd?: string; access?: AccessLevel; sessionId?: string; fast?: boolean; contextWindow?: number; providerOptions?: ProviderOptions };
  if (x.cwd !== undefined && typeof x.cwd !== "string") return fail(400, "x_funnel.cwd must be a string.", { param: "x_funnel.cwd" });
  const bad = unsupported(body);
  if (bad) return fail(400, `${bad} is not supported by cli-funnel with this value. Leave it out or use its default.`, { param: bad, code: "unsupported_value" });

  const resolved = resolveSelection(funnel, body.model, x, defaults, cwdAllowed);
  if (resolved instanceof Response) return resolved;
  const caps = funnel.providers[resolved.provider]!.capabilities;

  const converted = inputToMessages(body.input);
  if ("param" in converted) return fail(400, converted.message, { param: converted.param });
  const tools = toolOptions(body, !!caps.tools, functionOf);
  if ("param" in tools) return fail(400, tools.message, { param: tools.param, code: "unsupported_value" });
  const sampled = samplingOptions(body, caps.sampling, { stop: false });
  if ("message" in sampled) return fail(400, sampled.message, { param: sampled.param, code: sampled.code });
  const format = isObject(body.text) && isObject(body.text.format) ? body.text.format : undefined;
  const reasoning = isObject(body.reasoning) ? body.reasoning : undefined;
  const system = [typeof body.instructions === "string" ? body.instructions : "", ...converted.system].filter(Boolean).join("\n\n");

  const run = startRun(req.signal);
  const input: RunRequest = {
    runId: run.id,
    selection: {
      provider: resolved.provider,
      model: resolved.model,
      effort: typeof reasoning?.effort === "string" ? reasoning.effort : undefined,
      fast: x.fast,
      contextWindow: x.contextWindow,
      cwd: resolved.cwd,
      access: resolved.access,
    },
    messages: converted.messages,
    system: system || undefined,
    responseSchema: format?.type === "json_schema" && isObject(format.schema) ? { name: typeof format.name === "string" ? format.name : undefined, schema: format.schema } : undefined,
    maxOutputTokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined,
    ...sampled,
    ...tools,
    providerOptions: resolved.providerOptions,
    sessionId: typeof body.previous_response_id === "string" ? body.previous_response_id : x.sessionId,
    signal: run.signal,
    timeoutMs: run.timeoutMs,
    onApproval: () => "deny",
  };

  const createdAt = Math.floor(Date.now() / 1000);
  const fallbackId = `resp_${randomUUID().replace(/-/g, "")}`;
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const base = (id: string) => ({ id, object: "response", created_at: createdAt, model: body.model, ...(system ? { instructions: system } : {}) });
  const messageItem = (text: string, status: "in_progress" | "completed") => ({
    type: "message",
    id: messageId,
    status,
    role: "assistant",
    content: status === "completed" ? [{ type: "output_text", text, annotations: [] }] : [],
  });
  const finalResponse = (r: RunResult) => {
    const text = answerOf(input, r);
    const reason = incompleteReason(r.finishReason);
    return {
      ...base(r.sessionId ?? fallbackId),
      status: reason ? "incomplete" : "completed",
      incomplete_details: reason ? { reason } : null,
      error: null,
      output: [
        ...(text ? [messageItem(text, "completed")] : []),
        ...(r.pendingToolCalls ?? []).map((c) => callItem(c, stringifyArguments(c.input), "completed")),
      ],
      usage: usageOut(r.usage),
      x_funnel: { runId: run.id, queued, sessionId: r.sessionId, toolCalls: r.toolCalls, deniedActions: r.deniedActions },
    };
  };

  let queued: { waitedMs: number } | undefined;
  let streaming = false;
  const slot = runSlot(run, resolved.provider);
  try {
    queued = await slot.acquire();
    if (!body.stream) return json(finalResponse(await funnel.run(input)));

    const stream = funnel.stream(input);
    const started = await pullFirst(stream);
    if (started instanceof Response) return started;
    const { first } = started;
    let seq = 0;
    const ev = (type: string, fields: Json) => ({ type, sequence_number: seq++, ...fields });
    const events = (async function* () {
      let id = first.done || first.value.type !== "session" ? fallbackId : first.value.sessionId;
      yield ev("response.created", { response: { ...base(id), status: "in_progress", output: [], x_funnel: { runId: run.id, queued } } });
      yield ev("response.in_progress", { response: { ...base(id), status: "in_progress", output: [] } });
      let outputIndex = 0;
      let messageIndex: number | undefined;
      let streamed = "";
      const calls = new Map<string, { index: number; args: string }>();
      function* openMessage() {
        if (messageIndex !== undefined) return;
        messageIndex = outputIndex++;
        yield ev("response.output_item.added", { output_index: messageIndex, item: messageItem("", "in_progress") });
        yield ev("response.content_part.added", { item_id: messageId, output_index: messageIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      }
      function* textDelta(delta: string) {
        yield* openMessage();
        streamed += delta;
        yield ev("response.output_text.delta", { item_id: messageId, output_index: messageIndex, content_index: 0, delta, logprobs: [] });
      }
      function* openCall(c: { id: string; name: string }) {
        const call = { index: outputIndex++, args: "" };
        calls.set(c.id, call);
        yield ev("response.output_item.added", { output_index: call.index, item: callItem(c, "", "in_progress") });
        return call;
      }
      try {
        for await (const e of started.events) {
          if (e.type === "session") id = e.sessionId;
          else if (e.type === "text.delta" && !input.responseSchema) yield* textDelta(e.text);
          else if (e.type === "tool_call.delta") {
            const call = calls.get(e.id) ?? (yield* openCall(e));
            call.args += e.arguments;
            yield ev("response.function_call_arguments.delta", { item_id: `fc_${e.id}`, output_index: call.index, delta: e.arguments });
          } else if (e.type === "tool_call") {
            const args = stringifyArguments(e.input);
            const call = calls.get(e.id) ?? (yield* openCall(e));
            // Vendors that send a call whole have no deltas, so its arguments go out in one piece.
            if (!call.args) yield ev("response.function_call_arguments.delta", { item_id: `fc_${e.id}`, output_index: call.index, delta: args });
            yield ev("response.function_call_arguments.done", { item_id: `fc_${e.id}`, output_index: call.index, arguments: args });
            yield ev("response.output_item.done", { output_index: call.index, item: callItem(e, args, "completed") });
          } else if (e.type === "error") throw Object.assign(new Error(e.message), { code: e.code });
        }
        const r = await stream.result;
        // Codex and Antigravity send the answer in `done.text`, and a schema answer is sent whole at the end.
        const text = answerOf(input, r);
        const rest = text.startsWith(streamed) ? text.slice(streamed.length) : "";
        if (rest) yield* textDelta(rest);
        if (messageIndex !== undefined) {
          yield ev("response.output_text.done", { item_id: messageId, output_index: messageIndex, content_index: 0, text: streamed, logprobs: [] });
          yield ev("response.content_part.done", { item_id: messageId, output_index: messageIndex, content_index: 0, part: { type: "output_text", text: streamed, annotations: [] } });
          yield ev("response.output_item.done", { output_index: messageIndex, item: messageItem(streamed, "completed") });
        }
        const done = finalResponse({ ...r, sessionId: r.sessionId ?? id });
        yield ev(done.status === "incomplete" ? "response.incomplete" : "response.completed", { response: done });
      } catch (err) {
        const { error } = failure(err);
        yield ev("response.failed", { response: { ...base(id), status: "failed", error: { code: error.code ?? "server_error", message: error.message }, output: [] } });
      }
    })();
    streaming = true;
    return new Response(sse(tracked(events, slot.end), { event: (item) => (item as { type: string }).type, onCancel: slot.end }), { headers: sseHeaders });
  } catch (err) {
    return errorResponse(err);
  } finally {
    if (!streaming) slot.end();
  }
}
