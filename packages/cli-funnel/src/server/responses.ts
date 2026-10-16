import { randomUUID } from "node:crypto";
import type { Funnel } from "../funnel.js";
import { parseArguments, stringifyArguments } from "../messages.js";
import { BUSY_RETRY_AFTER_SEC } from "../queue.js";
import {
  FunnelError,
  type AccessLevel,
  type ContentPart,
  type FunnelEvent,
  type ImageAttachment,
  type ProviderOptions,
  type Message,
  type RunRequest,
  type RunResult,
  type ToolChoice,
  type ToolDefinition,
  type Usage,
} from "../types.js";
import { BodyError, DEFAULT_MAX_BODY_BYTES, readJson } from "./body.js";
import { IMAGE_DATA_URL, errorBody, fail, isObject, replay, resolveSelection, statusOf, type OpenAIDefaults, type TrackedRun } from "./openai.js";
import { json, sse, sseHeaders } from "./sse.js";

/**
 * `POST /v1/responses`: the OpenAI Responses API in front of any provider. The request becomes a run the same way
 * `/v1/chat/completions` does. The response id is the run's session id, so a client that sends it back as
 * `previous_response_id` continues the conversation, whatever keeps it: the CLI, the funnel's history or OpenAI.
 */

type Json = Record<string, unknown>;
type Problem = { message: string; param: string };

const SYSTEM_ROLES = new Set(["system", "developer"]);
const TEXT_PARTS = new Set(["input_text", "output_text", "text"]);

/** Input items as typed messages plus the system text found in them. Returns the problem when an item cannot be mapped. */
export function inputToMessages(input: unknown): { messages: Message[]; system: string[] } | Problem {
  if (typeof input === "string") return { messages: [{ role: "user", content: input }], system: [] };
  if (!Array.isArray(input) || input.length === 0) return { message: "input must be a string or a non-empty array of items.", param: "input" };
  const messages: Message[] = [];
  const system: string[] = [];
  // Calls join the assistant message before them, results the user message of results before them.
  const push = (role: Message["role"], parts: ContentPart[], joinable: (m: Message) => boolean) => {
    const last = messages.at(-1);
    if (last && last.role === role && Array.isArray(last.content) && joinable(last)) last.content.push(...parts);
    else messages.push({ role, content: parts });
  };
  for (const [i, raw] of input.entries()) {
    const at = `input[${i}]`;
    if (!isObject(raw)) return { message: `${at} must be an object.`, param: at };
    const type = raw.type ?? "message";
    if (type === "reasoning") continue;
    if (type === "function_call") {
      if (typeof raw.call_id !== "string" || typeof raw.name !== "string") return { message: `${at} needs a call_id and a name.`, param: at };
      push("assistant", [{ type: "tool_call", id: raw.call_id, name: raw.name, input: parseArguments(typeof raw.arguments === "string" ? raw.arguments : "") }], () => true);
      continue;
    }
    if (type === "function_call_output") {
      if (typeof raw.call_id !== "string") return { message: `${at} needs a call_id.`, param: at };
      const output = typeof raw.output === "string" ? raw.output : Array.isArray(raw.output) ? raw.output.map((p) => (isObject(p) && typeof p.text === "string" ? p.text : "")).join("") : "";
      push("user", [{ type: "tool_result", toolCallId: raw.call_id, output }], (m) => (m.content as ContentPart[]).every((p) => p.type === "tool_result"));
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
          const data = IMAGE_DATA_URL.exec(typeof p.image_url === "string" ? p.image_url : "");
          if (!data) return { message: `${param}: images must be base64 data URLs of png, jpeg, webp or gif.`, param };
          parts.push({ type: "image", mediaType: data[1] as ImageAttachment["mediaType"], data: data[2]! });
        } else if (p.type !== "refusal") return { message: `${param}: content part "${String(p.type)}" is not supported here.`, param };
      }
    } else return { message: `${at}.content must be a string or an array of parts.`, param: `${at}.content` };
    if (SYSTEM_ROLES.has(role)) system.push(parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
    else if (role === "user" || role === "assistant") messages.push({ role, content: typeof content === "string" ? content : parts });
    else return { message: `${at}.role "${role}" is not supported.`, param: `${at}.role` };
  }
  return { messages, system };
}

/** `tools` and `tool_choice` of a Responses request. Only function tools: hosted tools such as web search have no provider here. */
function toolOptions(body: Json, canCall: boolean): { tools?: ToolDefinition[]; toolChoice?: ToolChoice } | Problem {
  const list = body.tools ?? [];
  const choice = body.tool_choice;
  if (!Array.isArray(list)) return { message: "tools must be an array.", param: "tools" };
  if (!canCall && (list.length || (choice != null && choice !== "none" && choice !== "auto"))) {
    return { message: `${list.length ? "tools" : "tool_choice"} is not supported by this provider with this value. It runs its own tools.`, param: list.length ? "tools" : "tool_choice" };
  }
  const tools: ToolDefinition[] = [];
  for (const [i, t] of list.entries()) {
    if (!isObject(t) || t.type !== "function" || typeof t.name !== "string" || !t.name) return { message: `tools[${i}] must be a function tool with a name.`, param: `tools[${i}]` };
    tools.push({ name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), ...(isObject(t.parameters) ? { parameters: t.parameters } : {}) });
  }
  let toolChoice: ToolChoice | undefined;
  if (choice === "auto" || choice === "none" || choice === "required") toolChoice = choice;
  else if (isObject(choice) && choice.type === "function" && typeof choice.name === "string") toolChoice = { name: choice.name };
  else if (choice != null) return { message: 'tool_choice must be "auto", "none", "required" or a function.', param: "tool_choice" };
  return { ...(tools.length ? { tools } : {}), ...(toolChoice ? { toolChoice } : {}) };
}

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
  defaults: OpenAIDefaults = {},
  cwdAllowed: (cwd: string) => boolean = () => true,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  startRun: (signal: AbortSignal) => TrackedRun = (signal) => ({ id: `run_${Date.now().toString(36)}`, signal, end: () => {} }),
): Promise<Response> {
  if (req.method !== "POST") return json({ error: { message: "Not found" } }, 404);
  let body: Json;
  try {
    body = await readJson(req, maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyError) return fail(err.status, err.message, { code: err.status === 413 ? "request_too_large" : "invalid_json" });
    throw err;
  }
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
  const tools = toolOptions(body, !!caps.tools);
  if ("param" in tools) return fail(400, tools.message, { param: tools.param, code: "unsupported_value" });
  for (const field of ["temperature", "top_p"] as const) {
    const v = body[field];
    if (v != null && v !== 1 && !caps.sampling) return fail(400, `${field} is not supported by this provider. Leave it out or use 1.`, { param: field, code: "unsupported_value" });
  }
  const format = isObject(body.text) && isObject(body.text.format) ? body.text.format : undefined;
  const reasoning = isObject(body.reasoning) ? body.reasoning : undefined;
  const system = [typeof body.instructions === "string" ? body.instructions : "", ...converted.system].filter(Boolean).join("\n\n");
  const sampling = {
    ...(typeof body.temperature === "number" && caps.sampling ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" && caps.sampling ? { topP: body.top_p } : {}),
  };

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
    ...(Object.keys(sampling).length ? { sampling } : {}),
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
  const answerOf = (r: RunResult) => (input.responseSchema && r.structured !== undefined ? JSON.stringify(r.structured) : r.text);
  const messageItem = (text: string, status: "in_progress" | "completed") => ({
    type: "message",
    id: messageId,
    status,
    role: "assistant",
    content: status === "completed" ? [{ type: "output_text", text, annotations: [] }] : [],
  });
  const finalResponse = (r: RunResult) => {
    const text = answerOf(r);
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
  const failure = (err: unknown) => errorBody(err instanceof Error ? err.message : String(err), { type: "cli_funnel_error", code: (err as FunnelError).code });

  let queued: { waitedMs: number } | undefined;
  let streaming = false;
  let release: (() => void) | undefined;
  const end = () => {
    release?.();
    run.end();
  };
  try {
    // With a concurrency limit the request waits here for a slot, as on chat completions.
    if (run.queue) {
      const since = Date.now();
      let waited = false;
      release = await run.queue.acquire(resolved.provider, { signal: run.signal, onPosition: () => (waited = true) });
      if (waited) queued = { waitedMs: Date.now() - since };
    }
    if (!body.stream) return json(finalResponse(await funnel.run(input)));

    const stream = funnel.stream(input);
    const it = stream[Symbol.asyncIterator]();
    // Pull the first event before the 200 goes out, so a refused run can still be a 4xx.
    const first = await it.next();
    if (!first.done && first.value.type === "error") {
      await it.return?.();
      return json(failure(Object.assign(new Error(first.value.message), { code: first.value.code })), statusOf(first.value.code));
    }
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
        for await (const e of replay(first, it) as AsyncIterable<FunnelEvent>) {
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
        const text = answerOf(r);
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
    // The run stays cancellable until its body ends.
    const tracked = (async function* () {
      try {
        yield* events;
      } finally {
        end();
      }
    })();
    streaming = true;
    return new Response(sse(tracked, { event: (item) => (item as { type: string }).type, onCancel: end }), { headers: sseHeaders });
  } catch (err) {
    // A full queue, or a wait past queueTimeoutMs.
    if (err instanceof FunnelError && err.code === "busy") {
      return Response.json(failure(err), { status: 429, headers: { "retry-after": String(BUSY_RETRY_AFTER_SEC) } });
    }
    return json(failure(err), err instanceof FunnelError ? statusOf(err.code) : 500);
  } finally {
    if (!streaming) end();
  }
}
