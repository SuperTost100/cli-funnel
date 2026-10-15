import type { FinishReason, FunnelEvent, Selection, Usage } from "cli-funnel/client";

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
  finishReason?: FinishReason;
  status: "running" | "done" | "error";
  error?: string;
}

export function startTurn(id: number, prompt: string, selection: Selection): Turn {
  return { id, prompt, selection, model: selection.model, text: "", toolCalls: [], deniedActions: [], status: "running" };
}

/** Folds one event into a turn, the way `funnel.run()` folds events into a `RunResult`. */
export function applyEvent(turn: Turn, e: FunnelEvent): Turn {
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
  let next = turn;
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
