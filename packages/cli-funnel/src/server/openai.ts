import type { Funnel } from "../funnel.js";
import { isAbsolute } from "node:path";
import {
  ACCESS_LEVELS,
  type AccessLevel,
  type ContentPart,
  type FinishReason,
  type Message,
  type ProviderId,
  type ProviderOptions,
  type RunRequest,
  type Sampling,
  type ToolCall,
  type ToolCallPart,
  type Usage,
} from "../types.js";
import { parseArguments, stringifyArguments } from "../messages.js";
import { readJson } from "./body.js";
import { json, sse, sseHeaders } from "./sse.js";
import { real } from "../util/fs-roots.js";
import { isObject } from "../util/is-object.js";
import {
  SYSTEM_ROLES,
  answerOf,
  errorResponse,
  fail,
  failure,
  imagePart,
  notFound,
  pullFirst,
  pushToolResult,
  runSlot,
  toolOptions,
  tracked,
  type TrackedRun,
} from "./shared.js";

export interface OpenAIDefaults {
  /** Project directory the agent works in. Default: the server's cwd. Must be inside the handler's `fsRoots`. */
  cwd?: string;
  /**
   * Access level for chat-completions calls. Default "accept-edits". "supervised" is denied here because the wire format has no approve button.
   * A provider that cannot enforce the default gets the next stricter level it can, for example "none" on Cursor Agent.
   */
  access?: AccessLevel;
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
      const path = isAbsolute(d) ? real(d) : undefined;
      if (!path || !allowed(path)) return null;
      resolved.push(path);
    }
    entries.push([id, { ...(entry as object), addDirs: resolved }]);
  }
  // fromEntries keeps a "__proto__" key as a plain key, so validation still sees and refuses it.
  return Object.fromEntries(entries) as T;
}

const text = (c: ChatMessage["content"]) =>
  typeof c === "string" ? c : (c ?? []).map((p) => (p.type === "text" ? p.text ?? "" : "")).join("");

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
      pushToolResult(out, { type: "tool_result", toolCallId: m.tool_call_id, output: text(m.content) });
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
        const image = imagePart(p.image_url?.url ?? "");
        if (!image) return { message: `${param}: images must be base64 data URLs of png, jpeg, webp or gif.`, param };
        parts.push(image);
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

/** The function of a Chat Completions tool or tool_choice, which nests it under `function`. */
const functionOf = (v: unknown) => (isObject(v) && v.type === "function" && isObject(v.function) ? v.function : undefined);

const usageOut = (u?: Usage) =>
  u ? { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.totalTokens } : undefined;

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
  // `tools` and `tool_choice` depend on the provider, so `toolOptions` checks them. So do the sampling fields, in `samplingOptions`.
  const checks: [string, boolean][] = [
    ["n", notOne(body.n)],
    ["response_format", isObject(body.response_format) && body.response_format.type === "json_object"],
  ];
  return checks.find(([, bad]) => bad)?.[0];
}

/**
 * `RunInput.sampling` from the `temperature`, `top_p`, `stop` and `seed` of a request body, or the 400 problem. Shared by
 * `/v1/chat/completions` and `/v1/responses`, which has no `stop` or `seed` and passes `stop: false`.
 *
 * A bad type or an out of range value is refused on every provider, with the limits of the OpenAI API: `temperature`
 * 0 to 2, `top_p` 0 to 1, `stop` a string or up to 4 strings, `seed` an integer. A provider without
 * `capabilities.sampling` (the CLIs) cannot apply any of them. It refuses a value other than the default, `1` for
 * `temperature` and `top_p`, an empty `stop` or no `seed`, and ignores the defaults.
 */
export function samplingOptions(
  body: Record<string, unknown>,
  supported: boolean | undefined,
  fields: { stop: boolean } = { stop: true },
): { sampling?: Sampling } | { message: string; param: string; code: string } {
  const bad = (param: string, message: string) => ({ message, param, code: "invalid_value" });
  const set = (v: unknown) => v !== undefined && v !== null;
  const { temperature, top_p: topP, seed } = body;
  if (set(temperature) && (typeof temperature !== "number" || temperature < 0 || temperature > 2)) return bad("temperature", "temperature must be a number from 0 to 2.");
  if (set(topP) && (typeof topP !== "number" || topP < 0 || topP > 1)) return bad("top_p", "top_p must be a number from 0 to 1.");
  let stop: string[] | undefined;
  if (fields.stop) {
    if (set(seed) && !Number.isInteger(seed)) return bad("seed", "seed must be an integer.");
    const list = typeof body.stop === "string" ? [body.stop] : body.stop;
    if (set(list)) {
      if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) return bad("stop", "stop must be a string or an array of strings.");
      if (list.length > 4) return bad("stop", "stop takes at most 4 sequences.");
      if (list.length) stop = list;
    }
  }

  const requested: [string, boolean][] = [
    ["temperature", set(temperature) && temperature !== 1],
    ["top_p", set(topP) && topP !== 1],
    ["stop", !!stop],
    ["seed", fields.stop && set(seed)],
  ];
  if (!supported) {
    const found = requested.find(([, on]) => on);
    if (!found) return {};
    const only = found[0] === "temperature" || found[0] === "top_p" ? " or use 1" : "";
    return { message: `${found[0]} is not supported by this provider. Leave it out${only}.`, param: found[0], code: "unsupported_value" };
  }
  const sampling: Sampling = {
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof topP === "number" ? { topP } : {}),
    ...(stop ? { stop } : {}),
    ...(typeof seed === "number" && fields.stop ? { seed } : {}),
  };
  return Object.keys(sampling).length ? { sampling } : {};
}

/**
 * The provider, model, folder and access level of an OpenAI-style request, or the error response. Shared by
 * `/v1/chat/completions` and `/v1/responses`.
 */
export function resolveSelection(
  funnel: Funnel,
  modelId: string,
  x: { cwd?: string; access?: AccessLevel; providerOptions?: ProviderOptions } | undefined,
  defaults: OpenAIDefaults,
  cwdAllowed: (cwd: string) => boolean,
): { provider: ProviderId; model: string; cwd: string; access: AccessLevel; providerOptions?: ProviderOptions } | Response {
  const slash = modelId.indexOf("/");
  const provider = modelId.slice(0, slash) as ProviderId;
  const model = modelId.slice(slash + 1);
  if (slash < 0 || !funnel.providers[provider]) {
    return fail(400, 'model must look like "<provider>/<model>", for example "claude/claude-sonnet-5".', { param: "model", code: "invalid_value" });
  }
  let access = x?.access ?? defaults.access ?? "accept-edits";
  if (!ACCESS_LEVELS.includes(access)) {
    return fail(400, `Unknown access level "${access}". Use one of ${ACCESS_LEVELS.join(", ")}.`, { param: x?.access ? "x_funnel.access" : undefined, code: "invalid_value" });
  }
  const supported = funnel.providers[provider]!.capabilities.access;
  if (!x?.access && supported.length && !supported.includes(access)) {
    // Never grant more than the default. ACCESS_LEVELS runs from strictest to most open.
    const stricter = ACCESS_LEVELS.slice(0, ACCESS_LEVELS.indexOf(access)).filter((a) => a !== "supervised" && supported.includes(a));
    if (stricter.length) access = stricter.at(-1)!;
  }

  // The resolved folder is always checked, the server's default and process.cwd() included.
  // Providers with no access levels have no machine to protect, so they skip the check.
  const cwd = x?.cwd ?? defaults.cwd ?? process.cwd();
  if (supported.length && !cwdAllowed(cwd)) {
    const message = x?.cwd
      ? "x_funnel.cwd does not exist or is outside the allowed roots."
      : "The server's default folder does not exist or is outside the allowed roots. Start the server with a folder inside fsRoots.";
    return fail(403, message, { param: x?.cwd ? "x_funnel.cwd" : undefined, code: "path_not_allowed" });
  }
  const providerOptions = resolveOptionDirs(x?.providerOptions, cwdAllowed);
  if (providerOptions === null) {
    return fail(403, "An addDirs entry in x_funnel.providerOptions does not exist or is outside the allowed roots.", { param: "x_funnel.providerOptions", code: "path_not_allowed" });
  }
  return { provider, model, cwd, access, providerOptions };
}

/** Model ids on this endpoint are "<provider>/<model>", for example "claude/claude-sonnet-5". */
export async function handleOpenAI(
  funnel: Funnel,
  req: Request,
  path: string,
  defaults: OpenAIDefaults,
  cwdAllowed: (cwd: string) => boolean,
  maxBodyBytes: number,
  startRun: (signal: AbortSignal) => TrackedRun,
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

  if (req.method !== "POST" || path !== "/v1/chat/completions") return notFound();

  const raw = await readJson(req, maxBodyBytes);
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

  const resolved = resolveSelection(funnel, body.model, body.x_funnel, defaults, cwdAllowed);
  if (resolved instanceof Response) return resolved;
  const { provider, model, cwd, access, providerOptions } = resolved;

  const chat = toMessages(body.messages);
  if (!("messages" in chat)) return fail(400, chat.message, { param: chat.param });
  const tools = toolOptions(raw, !!funnel.providers[provider]!.capabilities.tools, functionOf);
  if ("message" in tools) return fail(400, tools.message, { param: tools.param, code: "unsupported_value" });
  const sampled = samplingOptions(raw, funnel.providers[provider]!.capabilities.sampling);
  if ("message" in sampled) return fail(400, sampled.message, { param: sampled.param, code: sampled.code });
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
    ...sampled,
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

  let streaming = false;
  const slot = runSlot(run, provider);
  try {
    // `queued` tells the client how long it waited for a slot.
    const queued = await slot.acquire();
    if (!body.stream) {
      const r = await funnel.run(input);
      const calls = r.pendingToolCalls ?? [];
      // OpenAI sends null content next to tool calls when the model wrote no text.
      const message = calls.length ? { role: "assistant", content: answerOf(input, r) || null, tool_calls: toolCallsOut(calls) } : { role: "assistant", content: answerOf(input, r) };
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
    const started = await pullFirst(stream);
    if (started instanceof Response) return started;
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
        for await (const e of started.events) {
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
        const rest = input.responseSchema ? answerOf(input, r) : r.text.startsWith(streamed) ? r.text.slice(streamed.length) : "";
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
    streaming = true;
    return new Response(sse(tracked(chunks, slot.end), { done: "[DONE]", onCancel: slot.end }), { headers: sseHeaders });
  } catch (err) {
    return errorResponse(err);
  } finally {
    if (!streaming) slot.end();
  }
}
