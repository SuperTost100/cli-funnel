import { FunnelError, type FunnelEvent, type ImageAttachment, type Message, type ProviderId, type ToolChoice, type ToolDefinition, type ToolResultPart } from "../types.js";
import { BUSY_RETRY_AFTER_SEC, type RunQueue } from "../queue.js";
import { isObject } from "../util/is-object.js";
import { json } from "./sse.js";

/**
 * What `/v1/chat/completions` and `/v1/responses` have in common: the error shapes, the pieces of request mapping that
 * read the same on both wires, and the life of a run from its queue slot to the end of its body.
 */

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

export const errorBody = (message: string, extra: { type?: string; param?: string; code?: string | null } = {}) => ({
  error: { message, type: extra.type ?? "invalid_request_error", param: extra.param ?? null, code: extra.code ?? null },
});
export const fail = (status: number, message: string, extra?: Parameters<typeof errorBody>[1]) => json(errorBody(message, extra), status);

export const notFound = () => fail(404, "Not found", { code: "not_found" });

/** A bad selection is the client's mistake. Other FunnelError codes mean the provider cannot take the run right now. */
export const statusOf = (code?: string) => (code === "invalid-selection" ? 400 : code ? 409 : 500);

/** The status for a thrown error: a FunnelError by its code, anything else is a server error. */
export const statusOfError = (err: unknown) => (err instanceof FunnelError ? statusOf(err.code) : 500);

/** A thrown error in the OpenAI error shape. */
export const failure = (err: unknown) =>
  errorBody(err instanceof Error ? err.message : String(err), { type: "cli_funnel_error", code: (err as FunnelError).code });

/** 429 for a full run queue, with the header that tells the client when to try again. */
export const tooBusy = (body: unknown) => Response.json(body, { status: 429, headers: { "retry-after": String(BUSY_RETRY_AFTER_SEC) } });

/** The response for an error thrown before the body started: a full queue or a wait past queueTimeoutMs is a 429. */
export function errorResponse(err: unknown): Response {
  if (err instanceof FunnelError && err.code === "busy") return tooBusy(failure(err));
  return json(failure(err), statusOfError(err));
}

/** With a schema the answer is the structured data, not the prose around it. */
export const answerOf = (request: { responseSchema?: unknown }, r: { text: string; structured?: unknown }) =>
  request.responseSchema && r.structured !== undefined ? JSON.stringify(r.structured) : r.text;

export const SYSTEM_ROLES = new Set(["system", "developer"]);

export const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/;

/** An image part from a data URL, or undefined when the URL is not a base64 png, jpeg, webp or gif. */
export function imagePart(url: string): ImageAttachment | undefined {
  const data = IMAGE_DATA_URL.exec(url);
  return data ? { type: "image", mediaType: data[1] as ImageAttachment["mediaType"], data: data[2]! } : undefined;
}

/** Adds a tool result. Results in a row answer one assistant turn, so they share one user message. */
export function pushToolResult(messages: Message[], result: ToolResultPart): void {
  const last = messages.at(-1);
  if (last?.role === "user" && Array.isArray(last.content) && last.content.every((p) => p.type === "tool_result")) last.content.push(result);
  else messages.push({ role: "user", content: [result] });
}

/**
 * `tools` and `tool_choice` as run options. Only function tools exist in these APIs. `fnOf` returns the part of a tool or
 * choice that holds the function (`name`, and for a tool `description` and `parameters`), or undefined when it is not a
 * function: Chat Completions nests it under `function`, Responses puts it on the item. Returns the problem when the
 * request asks for something the provider cannot do.
 */
export function toolOptions(
  body: Record<string, unknown>,
  canCall: boolean,
  fnOf: (v: unknown) => Record<string, unknown> | undefined,
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
    const fn = fnOf(t);
    if (!fn || typeof fn.name !== "string" || !fn.name) return { message: `tools[${i}] must be a function tool with a name.`, param: `tools[${i}]` };
    tools.push({
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      ...(isObject(fn.parameters) ? { parameters: fn.parameters } : {}),
    });
  }
  let toolChoice: ToolChoice | undefined;
  const named = fnOf(choice);
  if (choice === "auto" || choice === "none" || choice === "required") toolChoice = choice;
  else if (named && typeof named.name === "string") toolChoice = { name: named.name };
  else if (choice != null) return { message: 'tool_choice must be "auto", "none", "required" or a function.', param: "tool_choice" };
  return { ...(tools.length ? { tools } : {}), ...(toolChoice ? { toolChoice } : {}) };
}

/** Replays an event pulled off the iterator ahead of time, then the rest. Leaving early closes the iterator. */
export async function* replay(first: IteratorResult<FunnelEvent>, it: AsyncIterator<FunnelEvent>): AsyncGenerator<FunnelEvent> {
  if (!first.done) yield first.value;
  yield* { [Symbol.asyncIterator]: () => it };
}

/**
 * Pulls the first event before the 200 goes out. Validation errors surface here, so they can still be a 4xx, which is
 * the returned response. Otherwise returns that event and the whole stream, the first event included.
 */
export async function pullFirst(
  stream: AsyncIterable<FunnelEvent>,
): Promise<{ first: IteratorResult<FunnelEvent>; events: AsyncGenerator<FunnelEvent> } | Response> {
  const it = stream[Symbol.asyncIterator]();
  const first = await it.next();
  if (!first.done && first.value.type === "error") {
    await it.return?.();
    return json(failure(Object.assign(new Error(first.value.message), { code: first.value.code })), statusOf(first.value.code));
  }
  return { first, events: replay(first, it) };
}

/** The run stays cancellable until its body ends. */
export async function* tracked<T>(items: AsyncIterable<T>, end: () => void): AsyncGenerator<T> {
  try {
    yield* items;
  } finally {
    end();
  }
}

/** A run's place in the handler: the queue slot it waits for, and the tracking it gives back when it ends. */
export function runSlot(run: TrackedRun, provider: ProviderId) {
  let release: (() => void) | undefined;
  return {
    /** With a concurrency limit the request waits here for a slot. The result tells the client how long it waited, if it did. */
    async acquire(): Promise<{ waitedMs: number } | undefined> {
      if (!run.queue) return undefined;
      const since = Date.now();
      let waited = false;
      release = await run.queue.acquire(provider, { signal: run.signal, onPosition: () => (waited = true) });
      return waited ? { waitedMs: Date.now() - since } : undefined;
    },
    /** Gives back the slot and removes the run from the handler. */
    end() {
      release?.();
      run.end();
    },
  };
}
