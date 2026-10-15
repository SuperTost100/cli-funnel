import type { Funnel } from "../funnel.js";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  ACCESS_LEVELS,
  FunnelError,
  type AccessLevel,
  type ContentPart,
  type FinishReason,
  type FunnelEvent,
  type ImageAttachment,
  type Message,
  type ProviderId,
  type ProviderOptions,
  type RunRequest,
  type ToolCall,
  type ToolCallPart,
  type ToolChoice,
  type ToolDefinition,
  type ToolResultPart,
  type Usage,
} from "../types.js";
import { parseArguments, stringifyArguments } from "../messages.js";
import { BodyError, DEFAULT_MAX_BODY_BYTES, readJson } from "./body.js";
import { json, sse, sseHeaders } from "./sse.js";
import { BUSY_RETRY_AFTER_SEC, type RunQueue } from "../queue.js";

export interface OpenAIDefaults {
  /** Project directory the agent works in. Default: the server's cwd. Must be inside the handler's `fsRoots`. */
  cwd?: string;
  /**
   * Access level for chat-completions calls. Default "accept-edits". "supervised" is denied here because the wire format has no approve button.
   * A provider that cannot enforce the default gets the next stricter level it can, for example "none" on Cursor Agent.
   */
  access?: AccessLevel;
}

/** A run the handler can cancel by id. `end` removes it once the run is over. */
export interface TrackedRun {
  id: string;
  /** Aborts when the request closes or the run is cancelled by id. */
  signal: AbortSignal;
  /** The handler's deadline for the run. */
  timeoutMs?: number;
  /** The handler's run queue, when it limits concurrent runs. */
  queue?: RunQueue;
  end: () => void;
}

interface ChatMessage {
  role: string;
  content: string | { type: string; text?: string; image_url?: { url: string } }[] | null;
  /** On assistant messages. */
  tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
  /** On `tool` messages. */
  tool_call_id?: string;
}

interface ChatBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  reasoning_effort?: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: { type: string; json_schema?: { name?: string; schema?: Record<string, unknown> } };
  /** cli-funnel extension. */
  x_funnel?: { cwd?: string; access?: AccessLevel; sessionId?: string; fast?: boolean; contextWindow?: number; providerOptions?: ProviderOptions };
}

const realPath = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * `providerOptions` with every `addDirs` entry replaced by its real path, or `null` when an entry does not exist or
 * resolves outside `allowed`, the check `cwd` gets. The run gets the resolved path, so a symlink swapped in after the
 * check cannot point it elsewhere. Providers accept a single string or a list, so both are handled. Other value types
 * pass through for the provider to refuse.
 */
export function resolveOptionDirs<T>(options: T, allowed: (dir: string) => boolean): T | null {
  if (typeof options !== "object" || options === null || Array.isArray(options)) return options;
  const entries: [string, unknown][] = [];
  for (const [id, entry] of Object.entries(options)) {
    const dirs: unknown = typeof entry === "object" && entry !== null ? (entry as { addDirs?: unknown }).addDirs : undefined;
    if (typeof dirs !== "string" && !Array.isArray(dirs)) {
      entries.push([id, entry]);
      continue;
    }
    const resolved: unknown[] = [];
    for (const d of typeof dirs === "string" ? [dirs] : dirs) {
      if (typeof d !== "string") {
        resolved.push(d);
        continue;
      }
      const real = isAbsolute(d) ? realPath(d) : undefined;
      if (!real || !allowed(real)) return null;
      resolved.push(real);
    }
    entries.push([id, { ...(entry as object), addDirs: resolved }]);
  }
  // fromEntries keeps a "__proto__" key as a plain key, so validation still sees and refuses it.
  return Object.fromEntries(entries) as T;
}

const text = (c: ChatMessage["content"]) =>
  typeof c === "string" ? c : (c ?? []).map((p) => (p.type === "text" ? p.text ?? "" : "")).join("");

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/;

const SYSTEM_ROLES = new Set(["system", "developer"]);

/**
 * The chat as typed messages, without the system ones. Images must be data URLs: fetching remote URLs would make this
 * server a proxy. Assistant `tool_calls` become tool call parts. Each run of `tool` messages becomes one user message
 * of tool results. Returns the problem when a message cannot be mapped.
 */
function toMessages(messages: ChatMessage[]): { messages: Message[] } | { message: string; param: string } {
  const out: Message[] = [];
  for (const [i, m] of messages.entries()) {
    if (SYSTEM_ROLES.has(m.role)) continue;
    if (m.role === "tool") {
      if (typeof m.tool_call_id !== "string" || !m.tool_call_id) return { message: `messages[${i}].tool_call_id is required on tool messages.`, param: `messages[${i}].tool_call_id` };
      const result: ToolResultPart = { type: "tool_result", toolCallId: m.tool_call_id, output: text(m.content) };
      const last = out.at(-1);
      // Several tool messages in a row answer one assistant turn, so they share one user message.
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((p) => p.type === "tool_result")) last.content.push(result);
      else out.push({ role: "user", content: [result] });
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") return { message: `messages[${i}].role "${m.role}" is not supported.`, param: `messages[${i}].role` };
    const calls: ToolCallPart[] = [];
    if (m.role === "assistant" && m.tool_calls != null) {
      if (!Array.isArray(m.tool_calls)) return { message: `messages[${i}].tool_calls must be an array.`, param: `messages[${i}].tool_calls` };
      for (const [j, c] of m.tool_calls.entries()) {
        if (typeof c?.id !== "string" || typeof c.function?.name !== "string") {
          return { message: `messages[${i}].tool_calls[${j}] needs an id and a function name.`, param: `messages[${i}].tool_calls[${j}]` };
        }
        calls.push({ type: "tool_call", id: c.id, name: c.function.name, input: parseArguments(c.function.arguments ?? "") });
      }
    }
    if (typeof m.content === "string" || m.content == null) {
      out.push({ role: m.role, content: calls.length ? [...(m.content ? [{ type: "text" as const, text: m.content }] : []), ...calls] : m.content ?? "" });
      continue;
    }
    const parts: ContentPart[] = [];
    for (const [j, p] of m.content.entries()) {
      const param = `messages[${i}].content[${j}]`;
      if (p.type === "text") parts.push({ type: "text", text: p.text ?? "" });
      else if (p.type === "image_url" && m.role === "user") {
        const data = IMAGE_DATA_URL.exec(p.image_url?.url ?? "");
        if (!data) return { message: `${param}: images must be base64 data URLs of png, jpeg, webp or gif.`, param };
        parts.push({ type: "image", mediaType: data[1] as ImageAttachment["mediaType"], data: data[2]! });
      } else return { message: `${param}: content part "${p.type}" is not supported here.`, param };
    }
    out.push({ role: m.role, content: [...parts, ...calls] });
  }
  return { messages: out };
}

const finish = (r: FinishReason) => (r === "denied" ? "content_filter" : r === "length" ? "length" : r === "tool_calls" ? "tool_calls" : "stop");

/** Calls to the client's tools in the Chat Completions shape. */
const toolCallsOut = (calls: ToolCall[]) =>
  calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: stringifyArguments(c.input) } }));

/**
 * `tools` and `tool_choice` as run options. Only function tools exist in this API. Returns the problem when the
 * request asks for something the provider cannot do.
 */
function toolOptions(
  body: Record<string, unknown>,
  canCall: boolean,
): { tools?: ToolDefinition[]; toolChoice?: ToolChoice } | { message: string; param: string } {
  const list = body.tools == null ? [] : body.tools;
  const choice = body.tool_choice;
  if (!Array.isArray(list)) return { message: "tools must be an array.", param: "tools" };
  if (!canCall) {
    // Tools inside a CLI are its own. `none` and `auto` without tools ask for nothing, so they pass.
    const unsupported = (param: string) => ({ message: `${param} is not supported by this provider with this value. It runs its own tools.`, param });
    if (list.length) return unsupported("tools");
    if (choice != null && choice !== "none" && choice !== "auto") return unsupported("tool_choice");
    return {};
  }
  const tools: ToolDefinition[] = [];
  for (const [i, t] of list.entries()) {
    const fn = isObject(t) && t.type === "function" && isObject(t.function) ? t.function : undefined;
    if (!fn || typeof fn.name !== "string" || !fn.name) return { message: `tools[${i}] must be a function tool with a name.`, param: `tools[${i}]` };
    tools.push({
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      ...(isObject(fn.parameters) ? { parameters: fn.parameters } : {}),
    });
  }
  let toolChoice: ToolChoice | undefined;
  if (choice === "auto" || choice === "none" || choice === "required") toolChoice = choice;
  else if (isObject(choice) && choice.type === "function" && isObject(choice.function) && typeof choice.function.name === "string") toolChoice = { name: choice.function.name };
  else if (choice != null) return { message: 'tool_choice must be "auto", "none", "required" or a function.', param: "tool_choice" };
  return { ...(tools.length ? { tools } : {}), ...(toolChoice ? { toolChoice } : {}) };
}

const usageOut = (u?: Usage) =>
  u ? { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.totalTokens } : undefined;

const errorBody = (message: string, extra: { type?: string; param?: string; code?: string | null } = {}) => ({
  error: { message, type: extra.type ?? "invalid_request_error", param: extra.param ?? null, code: extra.code ?? null },
});
const fail = (status: number, message: string, extra?: Parameters<typeof errorBody>[1]) => json(errorBody(message, extra), status);

/** A bad selection is the client's mistake. Other FunnelError codes mean the provider cannot take the run right now. */
const statusOf = (code?: string) => (code === "invalid-selection" ? 400 : code ? 409 : 500);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Checks the shape of a chat body, so a malformed request gets a 400 and not a TypeError. Returns the problem, if any. */
function badShape(body: Record<string, unknown>): { message: string; param: string } | undefined {
  if (typeof body.model !== "string" || !body.model) return { message: "model is required and must be a string.", param: "model" };
  const { messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) return { message: "messages must be a non-empty array.", param: "messages" };
  for (const [i, m] of messages.entries()) {
    if (!isObject(m) || typeof m.role !== "string") return { message: `messages[${i}] must be an object with a string role.`, param: `messages[${i}]` };
    const c = m.content;
    if (!(c == null || typeof c === "string" || (Array.isArray(c) && c.every(isObject)))) {
      return { message: `messages[${i}].content must be a string or an array of content parts.`, param: `messages[${i}].content` };
    }
  }
  if (body.x_funnel !== undefined && !isObject(body.x_funnel)) return { message: "x_funnel must be an object.", param: "x_funnel" };
  const x = (body.x_funnel ?? {}) as Record<string, unknown>;
  if (x.cwd !== undefined && typeof x.cwd !== "string") return { message: "x_funnel.cwd must be a string.", param: "x_funnel.cwd" };
  if (body.stream_options != null && !isObject(body.stream_options)) return { message: "stream_options must be an object.", param: "stream_options" };
  return undefined;
}

/**
 * Request fields the funnel cannot honour. A client that sets one gets a 400 and not a plausible answer that ignored it.
 * Returns the first field set to something other than its default.
 */
function unsupportedField(body: Record<string, unknown>): string | undefined {
  const set = (v: unknown) => v !== undefined && v !== null;
  const notOne = (v: unknown) => set(v) && v !== 1;
  // `tools` and `tool_choice` depend on the provider, so `toolOptions` checks them.
  const checks: [string, boolean][] = [
    ["n", notOne(body.n)],
    ["stop", set(body.stop) && !(Array.isArray(body.stop) && body.stop.length === 0)],
    ["temperature", notOne(body.temperature)],
    ["top_p", notOne(body.top_p)],
    ["seed", set(body.seed)],
    ["response_format", isObject(body.response_format) && body.response_format.type === "json_object"],
  ];
  return checks.find(([, bad]) => bad)?.[0];
}

/** Replays an event pulled off the iterator ahead of time, then the rest. Leaving early closes the iterator. */
async function* replay(first: IteratorResult<FunnelEvent>, it: AsyncIterator<FunnelEvent>): AsyncGenerator<FunnelEvent> {
  if (!first.done) yield first.value;
  yield* { [Symbol.asyncIterator]: () => it };
}

/** Model ids on this endpoint are "<provider>/<model>", for example "claude/claude-sonnet-5". */
export async function handleOpenAI(
  funnel: Funnel,
  req: Request,
  path: string,
  defaults: OpenAIDefaults = {},
  cwdAllowed: (cwd: string) => boolean = () => true,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  startRun: (signal: AbortSignal) => TrackedRun = (signal) => ({ id: `run_${Date.now().toString(36)}`, signal, end: () => {} }),
): Promise<Response> {
  // Only providers that are installed and signed in, so a client never sees a model it cannot run.
  const listModels = async () => {
    const ready = (await funnel.overview()).filter((p) => p.installation.installed && p.auth?.loggedIn);
    const lists = await Promise.all(ready.map((p) => funnel.models(p.id).catch(() => [])));
    return ready.flatMap((p, i) => lists[i]!.map((m) => ({ id: `${p.id}/${m.id}`, object: "model", owned_by: p.id, name: m.name })));
  };

  if (req.method === "GET" && path === "/v1/models") return json({ object: "list", data: await listModels() });

  if (req.method === "GET" && path.startsWith("/v1/models/")) {
    let id: string;
    try {
      id = decodeURIComponent(path.slice("/v1/models/".length));
    } catch {
      id = "";
    }
    const found = (await listModels()).find((m) => m.id === id);
    return found ? json(found) : fail(404, `The model '${id}' does not exist.`, { param: "model", code: "model_not_found" });
  }

  if (req.method !== "POST" || path !== "/v1/chat/completions") return json({ error: { message: "Not found" } }, 404);

  let raw: Record<string, unknown>;
  try {
    raw = await readJson(req, maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyError) return fail(err.status, err.message, { code: err.status === 413 ? "request_too_large" : "invalid_json" });
    throw err;
  }
  const shape = badShape(raw);
  if (shape) return fail(400, shape.message, { param: shape.param });
  const unsupported = unsupportedField(raw);
  if (unsupported) {
    return fail(400, `${unsupported} is not supported by cli-funnel with this value. Leave it out or use its default.`, {
      param: unsupported,
      code: "unsupported_value",
    });
  }
  const body = raw as unknown as ChatBody;

  const slash = body.model.indexOf("/");
  const provider = body.model.slice(0, slash) as ProviderId;
  const model = body.model.slice(slash + 1);
  if (slash < 0 || !funnel.providers[provider]) {
    return json({ error: { message: 'model must look like "<provider>/<model>", for example "claude/claude-sonnet-5".' } }, 400);
  }
  let access = body.x_funnel?.access ?? defaults.access ?? "accept-edits";
  if (!ACCESS_LEVELS.includes(access)) return json({ error: { message: `bad access "${access}"` } }, 400);
  const supported = funnel.providers[provider]!.capabilities.access;
  if (!body.x_funnel?.access && supported.length && !supported.includes(access)) {
    // Never grant more than the default. ACCESS_LEVELS runs from strictest to most open.
    const stricter = ACCESS_LEVELS.slice(0, ACCESS_LEVELS.indexOf(access)).filter((a) => a !== "supervised" && supported.includes(a));
    if (stricter.length) access = stricter.at(-1)!;
  }

  // The resolved folder is always checked, the server's default and process.cwd() included.
  // Providers with no access levels have no machine to protect, so they skip the check.
  const cwd = body.x_funnel?.cwd ?? defaults.cwd ?? process.cwd();
  if (supported.length && !cwdAllowed(cwd)) {
    const message = body.x_funnel?.cwd
      ? "x_funnel.cwd does not exist or is outside the allowed roots."
      : "The server's default folder does not exist or is outside the allowed roots. Start the server with a folder inside fsRoots.";
    return json({ error: { message } }, 403);
  }
  const providerOptions = resolveOptionDirs(body.x_funnel?.providerOptions, cwdAllowed);
  if (providerOptions === null) {
    return json({ error: { message: "An addDirs entry in x_funnel.providerOptions does not exist or is outside the allowed roots." } }, 403);
  }

  const chat = toMessages(body.messages);
  if (!("messages" in chat)) return fail(400, chat.message, { param: chat.param });
  const tools = toolOptions(raw, !!funnel.providers[provider]!.capabilities.tools);
  if ("message" in tools) return fail(400, tools.message, { param: tools.param, code: "unsupported_value" });
  const system = body.messages.filter((m) => SYSTEM_ROLES.has(m.role)).map((m) => text(m.content)).join("\n\n");
  const run = startRun(req.signal);
  const input: RunRequest = {
    runId: run.id,
    selection: {
      provider,
      model,
      effort: body.reasoning_effort,
      fast: body.x_funnel?.fast,
      contextWindow: body.x_funnel?.contextWindow,
      cwd,
      access,
    },
    // System messages become the run's system prompt. The funnel renders the rest for providers without typed turns.
    messages: chat.messages,
    system: system || undefined,
    responseSchema:
      body.response_format?.type === "json_schema" && body.response_format.json_schema?.schema
        ? { name: body.response_format.json_schema.name, schema: body.response_format.json_schema.schema }
        : undefined,
    maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
    ...tools,
    sessionId: body.x_funnel?.sessionId,
    signal: run.signal,
    timeoutMs: run.timeoutMs,
    providerOptions,
    onApproval: () => "deny",
  };

  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: object, finish_reason: string | null = null, extra: object = {}) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: body.model,
    choices: [{ index: 0, delta, finish_reason }],
    ...extra,
  });
  const failure = (err: unknown) =>
    errorBody(err instanceof Error ? err.message : String(err), { type: "cli_funnel_error", code: (err as FunnelError).code });
  // With a schema the answer is the structured data, not the prose around it.
  const answerOf = (r: { text: string; structured?: unknown }) => (input.responseSchema && r.structured !== undefined ? JSON.stringify(r.structured) : r.text);

  let streaming = false;
  let release: (() => void) | undefined;
  const end = () => {
    release?.();
    run.end();
  };
  try {
    // With a concurrency limit the request waits here for a slot. `queued` tells the client how long it waited.
    let queued: { waitedMs: number } | undefined;
    if (run.queue) {
      const since = Date.now();
      let waited = false;
      release = await run.queue.acquire(provider, { signal: run.signal, onPosition: () => (waited = true) });
      if (waited) queued = { waitedMs: Date.now() - since };
    }
    if (!body.stream) {
      const r = await funnel.run(input);
      const calls = r.pendingToolCalls ?? [];
      // OpenAI sends null content next to tool calls when the model wrote no text.
      const message = calls.length ? { role: "assistant", content: answerOf(r) || null, tool_calls: toolCallsOut(calls) } : { role: "assistant", content: answerOf(r) };
      return json({
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [{ index: 0, message, finish_reason: finish(r.finishReason) }],
        usage: usageOut(r.usage),
        x_funnel: { runId: run.id, queued, sessionId: r.sessionId, toolCalls: r.toolCalls, deniedActions: r.deniedActions },
      });
    }

    const stream = funnel.stream(input);
    const it = stream[Symbol.asyncIterator]();
    // Pull the first event before the 200 goes out. Validation errors surface here, so they can still be a 4xx.
    const first = await it.next();
    if (!first.done && first.value.type === "error") {
      await it.return?.();
      return json(failure(Object.assign(new Error(first.value.message), { code: first.value.code })), statusOf(first.value.code));
    }
    const chunks = (async function* () {
      yield chunk({ role: "assistant" }, null, { x_funnel: { runId: run.id, queued } });
      try {
        let streamed = "";
        // Tool call index by id. The first chunk of a call carries its id and name; later ones only arguments.
        const callIndex = new Map<string, number>();
        const callChunk = (id: string, name: string, args: string) => {
          const index = callIndex.get(id);
          if (index !== undefined) return chunk({ tool_calls: [{ index, function: { arguments: args } }] });
          callIndex.set(id, callIndex.size);
          return chunk({ tool_calls: [{ index: callIndex.size - 1, id, type: "function", function: { name, arguments: args } }] });
        };
        for await (const e of replay(first, it)) {
          if (e.type === "text.delta") {
            streamed += e.text;
            if (!input.responseSchema) yield chunk({ content: e.text });
          } else if (e.type === "tool_call.delta") yield callChunk(e.id, e.name, e.arguments);
          // Vendors that send a call whole (Gemini, Ollama) have no deltas, so the call goes out in one chunk.
          else if (e.type === "tool_call" && !callIndex.has(e.id)) yield callChunk(e.id, e.name, stringifyArguments(e.input));
          else if (e.type === "error") throw Object.assign(new Error(e.message), { code: e.code });
        }
        const r = await stream.result;
        // Codex and Antigravity send the answer in `done.text`, not as deltas. Send whatever the deltas did not cover.
        const rest = input.responseSchema ? answerOf(r) : r.text.startsWith(streamed) ? r.text.slice(streamed.length) : "";
        if (rest) yield chunk({ content: rest });
        yield chunk({}, finish(r.finishReason), { x_funnel: { runId: run.id, sessionId: r.sessionId, toolCalls: r.toolCalls, deniedActions: r.deniedActions } });
        // OpenAI sends usage in a last chunk with no choices, and only to clients that ask for it.
        if (body.stream_options?.include_usage && r.usage) {
          yield { id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: usageOut(r.usage) };
        }
      } catch (err) {
        yield failure(err);
      }
    })();
    // The run stays cancellable until its body ends.
    const tracked = (async function* () {
      try {
        yield* chunks;
      } finally {
        end();
      }
    })();
    streaming = true;
    return new Response(sse(tracked, { done: "[DONE]", onCancel: end }), { headers: sseHeaders });
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
