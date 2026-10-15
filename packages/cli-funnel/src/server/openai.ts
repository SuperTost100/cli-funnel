import type { Funnel } from "../funnel.js";
import {
  ACCESS_LEVELS,
  FunnelError,
  type AccessLevel,
  type Attachment,
  type FinishReason,
  type FunnelEvent,
  type ProviderId,
  type RunInput,
  type Usage,
} from "../types.js";
import { BodyError, DEFAULT_MAX_BODY_BYTES, readJson } from "./body.js";
import { json, sse, sseHeaders } from "./sse.js";

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
  end: () => void;
}

interface ChatMessage {
  role: string;
  content: string | { type: string; text?: string; image_url?: { url: string } }[] | null;
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
  x_funnel?: { cwd?: string; access?: AccessLevel; sessionId?: string; fast?: boolean; contextWindow?: number };
}

const text = (c: ChatMessage["content"]) =>
  typeof c === "string" ? c : (c ?? []).map((p) => (p.type === "text" ? p.text ?? "" : "")).join("");

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/;

/** Images from the last user turn. Only data URLs: fetching remote URLs would make this server a proxy. */
function toAttachments(messages: ChatMessage[]): Attachment[] {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last || typeof last.content === "string" || !last.content) return [];
  return last.content.flatMap((p): Attachment[] => {
    const m = p.type === "image_url" && p.image_url ? IMAGE_DATA_URL.exec(p.image_url.url) : null;
    return m ? [{ type: "image", mediaType: m[1] as Attachment["mediaType"], data: m[2]! }] : [];
  });
}

/** Flattens a chat into one prompt. The CLI keeps its own history when sessionId is set, so only the last user turn is sent then. */
function toPrompt(messages: ChatMessage[], resumed: boolean): string {
  if (resumed) return text([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
  if (messages.length === 1) return text(messages[0]!.content);
  return messages.map((m) => `${m.role.toUpperCase()}: ${text(m.content)}`).join("\n\n");
}

const finish = (r: FinishReason) => (r === "denied" ? "content_filter" : r === "length" ? "length" : "stop");

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
  const checks: [string, boolean][] = [
    ["tools", Array.isArray(body.tools) ? body.tools.length > 0 : set(body.tools)],
    ["tool_choice", set(body.tool_choice) && body.tool_choice !== "none" && body.tool_choice !== "auto"],
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

  const system = body.messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n\n");
  const run = startRun(req.signal);
  const input: RunInput = {
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
    // System messages become the run's system prompt instead of a line in the flattened chat.
    prompt: toPrompt(body.messages.filter((m) => m.role !== "system"), !!body.x_funnel?.sessionId),
    system: system || undefined,
    attachments: toAttachments(body.messages),
    responseSchema:
      body.response_format?.type === "json_schema" && body.response_format.json_schema?.schema
        ? { name: body.response_format.json_schema.name, schema: body.response_format.json_schema.schema }
        : undefined,
    maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
    sessionId: body.x_funnel?.sessionId,
    signal: run.signal,
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
  try {
    if (!body.stream) {
      const r = await funnel.run(input);
      return json({
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: answerOf(r) }, finish_reason: finish(r.finishReason) }],
        usage: usageOut(r.usage),
        x_funnel: { runId: run.id, sessionId: r.sessionId, toolCalls: r.toolCalls, deniedActions: r.deniedActions },
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
      yield chunk({ role: "assistant" }, null, { x_funnel: { runId: run.id } });
      try {
        let streamed = "";
        for await (const e of replay(first, it)) {
          if (e.type === "text.delta") {
            streamed += e.text;
            if (!input.responseSchema) yield chunk({ content: e.text });
          } else if (e.type === "error") throw Object.assign(new Error(e.message), { code: e.code });
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
        run.end();
      }
    })();
    streaming = true;
    return new Response(sse(tracked, { done: "[DONE]", onCancel: run.end }), { headers: sseHeaders });
  } catch (err) {
    return json(failure(err), err instanceof FunnelError ? statusOf(err.code) : 500);
  } finally {
    if (!streaming) run.end();
  }
}
