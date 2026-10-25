import type { FileChange, FinishReason, FunnelEvent, Limit, PlanStep, Selection, Usage } from "cli-funnel/client";

export interface TurnToolCall {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  error?: string;
  /** True until the matching `tool.end` arrives. */
  running: boolean;
}

/** One prompt and the answer to it. */
export interface Turn {
  /** Unique within one `useRun`. Use it as the React key. */
  id: number;
  prompt: string;
  /** The selection this turn ran with. Later picker changes do not touch it. */
  selection: Selection;
  /** The model the CLI reported. Starts as `selection.model`. */
  model: string;
  sessionId?: string;
  text: string;
  structured?: unknown;
  /** Why `structured` is missing when a `responseSchema` was set. */
  structuredError?: string;
  toolCalls: TurnToolCall[];
  /** Names of the tool calls the CLI refused because nobody could approve them. */
  deniedActions: string[];
  usage?: Usage;
  /** The agent's latest plan, when the provider reports one. */
  plan?: PlanStep[];
  /** Files the agent added, changed or deleted in this turn, in order. */
  fileChanges?: FileChange[];
  finishReason?: FinishReason;
  /** Runs waiting ahead of this one while the server holds it for a slot. Cleared when the run starts. */
  queued?: number;
  /** The first rate limit or quota the provider reported during this turn. */
  limit?: Limit;
  /** When the `limit` event arrived, in ms since the epoch. Anchors `limit.retryAfterMs`. */
  limitAt?: number;
  status: "running" | "done" | "error";
  error?: string;
}

export function startTurn(id: number, prompt: string, selection: Selection): Turn {
  return { id, prompt, selection, model: selection.model, text: "", toolCalls: [], deniedActions: [], status: "running" };
}

/** Folds one event into a turn, the way `funnel.run()` folds events into a `RunResult`. */
export function applyEvent(turn: Turn, e: FunnelEvent, now: number = Date.now()): Turn {
  if (e.type === "queue.position") return { ...turn, queued: e.ahead };
  // Any other event means the run left the queue.
  if (turn.queued !== undefined) turn = { ...turn, queued: undefined };
  switch (e.type) {
    case "session":
      return { ...turn, sessionId: e.sessionId, model: e.model ?? turn.model };
    case "text.delta":
      return { ...turn, text: turn.text + e.text };
    case "tool.start":
      return { ...turn, toolCalls: [...turn.toolCalls, { id: e.id, name: e.name, input: e.input, running: true }] };
    case "tool.end": {
      const call = turn.toolCalls.find((c) => c.id === e.id);
      const toolCalls = turn.toolCalls.map((c) => (c.id === e.id ? { ...c, output: e.output ?? c.output, error: e.error ?? c.error, running: false } : c));
      const denied = e.error?.startsWith("denied:") ? [call?.name ?? e.error.slice(7).trim()] : [];
      return { ...turn, toolCalls, deniedActions: [...turn.deniedActions, ...denied] };
    }
    case "usage":
      return { ...turn, usage: e.usage };
    case "plan":
      return { ...turn, plan: e.steps };
    case "file.change": {
      const { type: _, ...change } = e;
      return { ...turn, fileChanges: [...(turn.fileChanges ?? []), change] };
    }
    case "limit": {
      if (turn.limit) return turn;
      const { type: _, ...limit } = e;
      return { ...turn, limit, limitAt: now };
    }
    case "structured":
      return { ...turn, structured: e.data, structuredError: undefined };
    case "done":
      return { ...turn, text: e.text || turn.text, finishReason: e.finishReason };
    case "error":
      return { ...turn, status: "error", error: e.message, finishReason: "error" };
    default:
      return turn;
  }
}

/** Parses a JSON answer, tolerating a surrounding code fence. Throws when the text is not JSON. */
function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

/**
 * Closes a turn when its stream ends. `aborted` marks a run the user stopped. With `responseSchema`
 * set and no structured answer from the provider, the text is parsed as JSON.
 */
export function endTurn(turn: Turn, opts: { aborted?: boolean; responseSchema?: boolean; error?: string } = {}): Turn {
  let next = turn.queued === undefined ? turn : { ...turn, queued: undefined };
  if (opts.error && next.status !== "error") next = { ...next, status: "error", error: opts.error, finishReason: "error" };
  if (next.status === "running") next = { ...next, status: "done", finishReason: next.finishReason ?? (opts.aborted ? "cancelled" : undefined) };
  if (next.toolCalls.some((c) => c.running)) next = { ...next, toolCalls: next.toolCalls.map((c) => ({ ...c, running: false })) };
  if (opts.responseSchema && next.structured === undefined && (next.finishReason === "stop" || next.finishReason === "length")) {
    try {
      next = { ...next, structured: parseJsonAnswer(next.text) };
    } catch (err) {
      next = { ...next, structuredError: `The answer is not JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return next;
}

/** The line a transcript shows while a run waits for a slot. */
export function queueNote(ahead: number): string {
  if (ahead <= 0) return "Waiting for a free slot. You are next.";
  return `Waiting for a free slot. ${ahead} ${ahead === 1 ? "run" : "runs"} ahead.`;
}

function span(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export interface LimitNote {
  /** "Rate limit" or "Quota reached". */
  title: string;
  /** The provider's own words. */
  detail: string;
  /** When it resets or when to retry, in local time with a relative span. Undefined when the provider gave no time. */
  when?: string;
}

/**
 * Words for a `Limit`. Times are formatted in the viewer's time zone. `receivedAt` anchors `retryAfterMs`,
 * `now` anchors the relative span. Pass `locale` and `timeZone` to pin the output, as tests do.
 */
export function describeLimit(limit: Limit, receivedAt: number, now: number, opts: { locale?: string; timeZone?: string } = {}): LimitNote {
  const title = limit.kind === "quota" ? "Quota reached" : "Rate limit";
  const parsed = limit.resetAt ? Date.parse(limit.resetAt) : NaN;
  const reset = Number.isNaN(parsed) ? undefined : parsed;
  const retry = limit.retryAfterMs === undefined ? undefined : receivedAt + limit.retryAfterMs;
  const at = reset ?? retry;
  if (at === undefined) return { title, detail: limit.detail };
  const verb = reset !== undefined ? "Resets" : "Retry";
  if (at <= now) return { title, detail: limit.detail, when: reset !== undefined ? "Should have reset by now." : "You can retry now." };
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: opts.timeZone });
  const sameDay = day.format(at) === day.format(now);
  const clock = new Intl.DateTimeFormat(opts.locale, {
    timeZone: opts.timeZone,
    hour: "numeric",
    minute: "2-digit",
    ...(sameDay ? {} : { weekday: "short", month: "short", day: "numeric" }),
  }).format(at);
  const near = at - now < 90_000;
  return { title, detail: limit.detail, when: `${verb} in ${span(at - now)}${near ? "" : `, at ${clock}`}.` };
}
