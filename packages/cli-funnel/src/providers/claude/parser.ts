import { isAbsolute, resolve } from "node:path";
import type { AccessLevel, FileChange, FinishReason, FunnelEvent, Limit, PlanStep, RateLimits, Usage, UsageWindow } from "../../types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" ? v : 0);

function toolOutput(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((c) => (isObj(c) && typeof c.text === "string" ? [c.text] : []));
  return text.length ? text.join("\n") : undefined;
}

/** A file edit tool call that has started: the absolute path, and whether the file existed when the call started. */
export interface EditCall {
  path: string;
  existed: boolean;
}

/**
 * What the parser remembers between the messages of one process. The caller fills `edits` at `tool.start`, because the
 * existence check reads the disk, and `declined` with the calls it denied through `can_use_tool`.
 */
export interface ClaudeTrack {
  edits: Map<string, EditCall>;
  declined: Set<string>;
  /** Edits that failed with no denial from the provider. The `result` message says whether a permission rule refused them. */
  failedEdits: Map<string, EditCall>;
  /** The task list built from TaskCreate and TaskUpdate, in creation order. */
  tasks: { id: string; text: string; status: PlanStep["status"] }[];
  /** TaskCreate and TaskUpdate calls waiting for their result, by tool use id. */
  taskCalls: Map<string, { name: string; input: Obj }>;
  /** Forwarded subagent tool calls in this turn, by tool use id, so a denial in the `result` keeps their parent. */
  subagentCalls: Map<string, Subagent>;
  /** The warnings the process printed on stderr and no turn has reported yet. The caller feeds it the stderr lines. */
  notices: StderrWarnings;
}

/** The subagent a message belongs to: the id of the tool call that started it, and its type when the CLI names it. */
interface Subagent {
  parentId: string;
  agent?: string;
}

/** Which subagent messages to turn into events. `text` goes with `--forward-subagent-text`. `tools` needs no flag. */
export interface ForwardSubagents {
  text?: boolean;
  tools?: boolean;
}

export const newClaudeTrack = (): ClaudeTrack => ({
  edits: new Map(),
  declined: new Set(),
  failedEdits: new Map(),
  tasks: [],
  taskCalls: new Map(),
  subagentCalls: new Map(),
  notices: new StderrWarnings(),
});

/** The most warnings kept while no turn reads them, so an idle live session cannot grow without bound. */
const MAX_HELD_WARNINGS = 100;

/** How long after its last line an open warning counts as complete. The lines of one warning arrive in one write. */
const WARNING_QUIET_MS = 50;

/**
 * Finds the warnings in Claude Code's stderr. A line that starts with `Warning: ` or `⚠ ` starts one, and the message is
 * the text after the marker. Lines that directly follow it and start with whitespace belong to it, joined with one space.
 * Every other line, `Error:` lines included, is ignored: the provider puts those into the error of a failed run.
 *
 * A warning is complete once a line that does not continue it has followed, or once `WARNING_QUIET_MS` passed since
 * its last line: the CLI writes the lines of one warning together, and most warnings are a single line with nothing
 * after it. `takeComplete` returns only complete ones, so a continuation line that arrives after an ordinary drain
 * still joins its warning. `take` is the final drain: it returns the open warning too, for the caller that is about to
 * end the turn. `add` queues a warning the CLI sent in its stdout, so both sources share one order.
 */
export class StderrWarnings {
  private open: string | undefined;
  /** When the open warning got its last line. */
  private openAt = 0;
  private readonly done: string[] = [];

  push(line: string, now: number = Date.now()): void {
    const marker = line.match(/^(?:Warning: |⚠\uFE0F? )/)?.[0];
    if (marker) {
      this.close();
      this.open = line.slice(marker.length).trim();
      this.openAt = now;
    } else if (this.open !== undefined && /^\s/.test(line) && line.trim()) {
      this.open += ` ${line.trim()}`;
      this.openAt = now;
    } else {
      this.close();
    }
  }

  /** Queues a warning that is complete as it is. */
  add(message: string): void {
    this.close();
    this.open = message;
    this.close();
  }

  /** The complete warnings, oldest first. An open one that is still fresh stays, and none is returned again. */
  takeComplete(now: number = Date.now()): string[] {
    if (now - this.openAt >= WARNING_QUIET_MS) this.close();
    return this.done.splice(0);
  }

  /** Every warning seen so far, the open one included, oldest first. None is returned again. */
  take(): string[] {
    this.close();
    return this.done.splice(0);
  }

  /** Forgets the warnings seen so far, the open one included. */
  clear(): void {
    this.open = undefined;
    this.done.length = 0;
  }

  private close(): void {
    if (this.open && this.done.length < MAX_HELD_WARNINGS) this.done.push(this.open);
    this.open = undefined;
  }
}

/** Tools that write one file, and the input field that holds its path. Shell commands are not covered. */
const EDIT_TOOLS: Record<string, string> = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

/** The absolute path an edit tool call writes, or undefined for other tools. A relative path is resolved against `cwd`. */
export function editPath(name: string, input: unknown, cwd: string): string | undefined {
  const field = EDIT_TOOLS[name];
  const path = field && isObj(input) ? input[field] : undefined;
  if (typeof path !== "string" || !path) return undefined;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

const PLAN_STATUS: Record<string, PlanStep["status"]> = { pending: "pending", in_progress: "in_progress", completed: "done" };

/** TodoWrite sends the whole list each time. Items with an unknown status are dropped. */
function todoPlan(input: unknown): FunnelEvent[] {
  if (!isObj(input) || !Array.isArray(input.todos)) return [];
  const steps = input.todos.flatMap((t): PlanStep[] => {
    const status = isObj(t) && typeof t.status === "string" ? PLAN_STATUS[t.status] : undefined;
    return status && isObj(t) && typeof t.content === "string" ? [{ text: t.content, status }] : [];
  });
  return [{ type: "plan", steps }];
}

const taskPlan = (track: ClaudeTrack): FunnelEvent => ({ type: "plan", steps: track.tasks.map(({ text, status }) => ({ text, status })) });

/**
 * Applies a successful TaskCreate or TaskUpdate to the task list. TaskCreate gets its id from the result, TaskUpdate
 * names it in its input. Tasks made before this process started, as in a resumed session, are unknown, so updates to
 * them are ignored.
 */
function taskResult(track: ClaudeTrack, call: { name: string; input: Obj }, result: unknown, text: string | undefined): FunnelEvent[] {
  const { input } = call;
  if (call.name === "TaskCreate") {
    const fromResult = isObj(result) && isObj(result.task) ? result.task.id : undefined;
    const id = typeof fromResult === "string" ? fromResult : text?.match(/^Task #(\S+) created/)?.[1];
    if (!id || typeof input.subject !== "string") return [];
    track.tasks.push({ id, text: input.subject, status: "pending" });
    return [taskPlan(track)];
  }
  if (isObj(result) && result.success === false) return [];
  const i = track.tasks.findIndex((t) => t.id === String(input.taskId));
  if (i < 0) return [];
  const task = track.tasks[i]!;
  const status = typeof input.status === "string" ? PLAN_STATUS[input.status] : undefined;
  if (input.status === "deleted") track.tasks.splice(i, 1);
  else if (status) task.status = status;
  if (typeof input.subject === "string") task.text = input.subject;
  return [taskPlan(track)];
}

/**
 * The kind of change an edit made. Write reports `create` or `update` in its result, which stays right when the tool
 * ran before the existence check at `tool.start`. Other edits, and calls that never ran, use that check.
 */
function editKind(call: EditCall, result: unknown): FileChange["kind"] {
  if (isObj(result) && result.type === "create") return "add";
  if (isObj(result) && result.type === "update") return "update";
  return call.existed ? "update" : "add";
}

const fileChange = (id: string, call: EditCall, kind: FileChange["kind"], status: FileChange["status"]): FunnelEvent => ({
  type: "file.change",
  id,
  path: call.path,
  kind,
  status,
});

/**
 * Events for one subagent message, in block order. Text blocks of an `assistant` message become `subagent.text` with
 * `forward.text`, which goes with `--forward-subagent-text`. Thinking blocks are left out: the CLI sends them empty.
 * With `forward.tools`, `tool_use` blocks become `tool.start` and the `tool_result` blocks of a `user` message become
 * `tool.end`, both tagged with the subagent. Claude Code sends those messages without a flag. The subagent's prompt
 * (a `user` message with text) is left out: the parent's `Agent` tool call already carries it. Subagent calls never
 * reach the run's edit, task or plan tracking.
 */
function subagentEvents(raw: Obj, forward: ForwardSubagents, track: ClaudeTrack): FunnelEvent[] {
  if (typeof raw.parent_tool_use_id !== "string" || !isObj(raw.message) || !Array.isArray(raw.message.content)) return [];
  const sub: Subagent = { parentId: raw.parent_tool_use_id, ...(typeof raw.subagent_type === "string" ? { agent: raw.subagent_type } : {}) };
  return raw.message.content.flatMap((b): FunnelEvent[] => {
    if (!isObj(b)) return [];
    if (raw.type === "assistant" && forward.text && b.type === "text" && typeof b.text === "string" && b.text) {
      return [{ type: "subagent.text", parentId: sub.parentId, text: b.text, ...(sub.agent ? { agent: sub.agent } : {}) }];
    }
    if (raw.type === "assistant" && forward.tools && b.type === "tool_use" && typeof b.id === "string") {
      track.subagentCalls.set(b.id, sub);
      return [{ type: "tool.start", id: b.id, name: String(b.name), input: b.input, ...sub }];
    }
    if (raw.type === "user" && forward.tools && b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const out = toolOutput(b.content);
      const end = b.is_error === true ? { error: out ?? "Tool failed." } : { output: out };
      return [{ type: "tool.end", id: b.tool_use_id, ...end, ...sub }];
    }
    return [];
  });
}

/**
 * `apiKeySource` in `init` says where the API credential came from. `none` means no API key: the saved account login,
 * or a token or cloud provider that cli-funnel does not set up. The CLI's other values are legacy names it never sends.
 */
const AUTH: Record<string, "account" | "api-key"> = {
  none: "account",
  ANTHROPIC_API_KEY: "api-key",
  apiKeyHelper: "api-key",
  "/login managed key": "api-key",
};

/** The `--permission-mode` value for each access level. */
export const PERMISSION_MODE: Record<AccessLevel, string> = {
  // With every tool removed there is nothing to approve. `manual` keeps it that way if a tool slips in.
  none: "manual",
  supervised: "manual",
  "accept-edits": "acceptEdits",
  auto: "auto",
  full: "bypassPermissions",
};

/** The modes `init` reports, from the narrowest to the widest. `plan` and `dontAsk` are not on the scale. */
const MODES = ["default", "acceptEdits", "auto", "bypassPermissions"];

/**
 * `access.reduced` for an `init` line, when the CLI started in a narrower mode than `access` asked for. Managed
 * settings that switch a mode off, or a model that lacks auto mode, leave it in `default` without an error.
 */
function accessReduced(init: Obj, access: AccessLevel | undefined): FunnelEvent[] {
  if (!access) return [];
  const expected = PERMISSION_MODE[access];
  const started = init.permissionMode;
  // `manual` is reported as `default`, the narrowest mode, so the levels that ask for it have nothing to compare.
  if (!MODES.includes(expected) || typeof started !== "string" || !MODES.includes(started)) return [];
  return MODES.indexOf(started) < MODES.indexOf(expected) ? [{ type: "access.reduced", access, expected, started }] : [];
}

/**
 * Maps one stream-json object from `claude -p` to zero or more FunnelEvents. Messages from subagents are dropped unless
 * `forward` asks for their text or their tool calls (see `subagentEvents`). `access` is the level the run asked for, which
 * `access.reduced` compares with the mode in `init`. `track` carries what one process needs
 * across messages: the task list for `plan`, and the edit calls for `file.change`. The parser does no I/O.
 */
export function parseClaudeMessage(raw: unknown, forward: ForwardSubagents = {}, track: ClaudeTrack = newClaudeTrack(), access?: AccessLevel): FunnelEvent[] {
  if (!isObj(raw)) return [];
  const type = raw.type;

  if (type === "system" && raw.subtype === "init" && typeof raw.session_id === "string") {
    const auth = typeof raw.apiKeySource === "string" ? AUTH[raw.apiKeySource] : undefined;
    return [{ type: "session", sessionId: raw.session_id, model: typeof raw.model === "string" ? raw.model : undefined, ...(auth ? { auth } : {}) }, ...accessReduced(raw, access)];
  }

  if (type === "rate_limit_event" && isObj(raw.rate_limit_info)) return parseRateLimit(raw.rate_limit_info);

  // The CLI's own user notice, such as "Fast mode disabled · usage credit limit reached". Low and medium ones are hints.
  if (type === "system" && raw.subtype === "notification") {
    const urgent = raw.priority === "high" || raw.priority === "immediate";
    return urgent && typeof raw.text === "string" && raw.text ? [{ type: "warning", message: raw.text }] : [];
  }

  // Subagent traffic carries a parent id. The main thread is surfaced as it is, the subagents' messages only on request.
  if (raw.parent_tool_use_id) return forward.text || forward.tools ? subagentEvents(raw, forward, track) : [];

  if (type === "stream_event" && isObj(raw.event) && raw.event.type === "content_block_delta" && isObj(raw.event.delta)) {
    const d = raw.event.delta;
    if (d.type === "text_delta" && typeof d.text === "string") return [{ type: "text.delta", text: d.text }];
    if (d.type === "thinking_delta" && typeof d.thinking === "string") return [{ type: "reasoning.delta", text: d.thinking }];
    return [];
  }

  // Text and thinking arrive as deltas. Complete assistant messages are only used for tool calls.
  if (type === "assistant" && isObj(raw.message) && Array.isArray(raw.message.content)) {
    return raw.message.content.flatMap((b): FunnelEvent[] => {
      if (!isObj(b) || b.type !== "tool_use" || typeof b.id !== "string") return [];
      const start: FunnelEvent = { type: "tool.start", id: b.id, name: String(b.name), input: b.input };
      if (b.name === "TodoWrite") return [start, ...todoPlan(b.input)];
      if ((b.name === "TaskCreate" || b.name === "TaskUpdate") && isObj(b.input)) track.taskCalls.set(b.id, { name: b.name, input: b.input });
      return [start];
    });
  }

  if (type === "user" && isObj(raw.message) && Array.isArray(raw.message.content)) {
    const blocks = raw.message.content.filter((b): b is Obj => isObj(b) && b.type === "tool_result" && typeof b.tool_use_id === "string");
    // `tool_use_result` is the tool's structured output. It can only be matched to a block when the message has one.
    const structured = blocks.length === 1 ? raw.tool_use_result : undefined;
    return blocks.flatMap((b): FunnelEvent[] => {
      const id = b.tool_use_id as string;
      const out = toolOutput(b.content);
      const failed = b.is_error === true;
      const events: FunnelEvent[] = [failed ? { type: "tool.end", id, error: out ?? "Tool failed." } : { type: "tool.end", id, output: out }];
      const task = track.taskCalls.get(id);
      if (task) {
        track.taskCalls.delete(id);
        if (!failed) events.push(...taskResult(track, task, structured, out));
      }
      const edit = track.edits.get(id);
      if (edit) {
        track.edits.delete(id);
        if (!failed) events.push(fileChange(id, edit, editKind(edit, structured), "done"));
        else if (track.declined.has(id)) events.push(fileChange(id, edit, editKind(edit, undefined), "declined"));
        else track.failedEdits.set(id, edit);
      }
      return events;
    });
  }

  if (type === "result") {
    const events = [...settleEdits(raw, track), ...parseResult(raw, track)];
    track.subagentCalls.clear();
    return events;
  }
  return [];
}

/**
 * At the end of a turn, edits that failed with no denial from the provider become `declined` when the result lists
 * them in `permission_denials` (a permission rule or the access level refused them), and `failed` otherwise.
 */
function settleEdits(r: Obj, track: ClaudeTrack): FunnelEvent[] {
  const list = Array.isArray(r.permission_denials) ? r.permission_denials : [];
  const denied = new Set(list.flatMap((d) => (isObj(d) && typeof d.tool_use_id === "string" ? [d.tool_use_id] : [])));
  const events: FunnelEvent[] = [];
  for (const [id, edit] of track.failedEdits) events.push(fileChange(id, edit, editKind(edit, undefined), denied.has(id) ? "declined" : "failed"));
  // An edit refused before it ran may have no tool result at all.
  for (const [id, edit] of track.edits) if (denied.has(id)) events.push(fileChange(id, edit, editKind(edit, undefined), "declined"));
  track.failedEdits.clear();
  track.edits.clear();
  track.declined.clear();
  return events;
}

/** Names of Claude's subscription windows, for the limit's detail text. */
const WINDOWS: Record<string, string> = {
  five_hour: "five-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "extra usage",
};

/**
 * `rate_limit_event` reports the subscription's usage windows on every turn. Only `rejected` means a limit was hit.
 * The five-hour window counts as a rate limit, the weekly windows and extra usage as a quota.
 */
function parseRateLimit(info: Obj): FunnelEvent[] {
  if (info.status !== "rejected") return [];
  const window = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
  const resetAt = typeof info.resetsAt === "number" ? new Date(info.resetsAt * 1000).toISOString() : undefined;
  return [{ type: "limit", ...windowLimit(window, resetAt) }];
}

/** The limit for a full usage window, worded the same in a `limit` event and in `RateLimits.limit`. */
function windowLimit(window: string | undefined, resetAt: string | undefined): Limit {
  const name = (window && WINDOWS[window]) ?? "usage";
  return { kind: window === "five_hour" ? "rate" : "quota", detail: `Claude ${name} limit reached.`, ...(resetAt ? { resetAt } : {}) };
}

/** One entry of `rate_limits` in the `get_usage` answer. `utilization` is a percentage from 0 to 100 and `resets_at` is ISO 8601. */
function usageWindow(w: unknown, windowMinutes: number): UsageWindow | undefined {
  if (!isObj(w) || typeof w.utilization !== "number") return undefined;
  const at = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
  return { usedPercent: w.utilization, windowMinutes, ...(Number.isNaN(at) ? {} : { resetsAt: new Date(at).toISOString() }) };
}

/**
 * The inner `response` of a successful `get_usage` control request. `primary` is the five-hour window and `secondary`
 * the seven-day one. `limit` is set when a window is full (100%), the five-hour one first, as Codex does. A login with
 * an API key has `rate_limits: null`, which gives a result with no windows.
 */
export function parseUsage(response: unknown): RateLimits {
  const r = isObj(response) ? response : {};
  const windows = isObj(r.rate_limits) ? r.rate_limits : {};
  const primary = usageWindow(windows.five_hour, 300);
  const secondary = usageWindow(windows.seven_day, 10_080);
  const full = primary && primary.usedPercent >= 100 ? (["five_hour", primary] as const) : secondary && secondary.usedPercent >= 100 ? (["seven_day", secondary] as const) : undefined;
  return {
    provider: "claude",
    ...(typeof r.subscription_type === "string" ? { plan: r.subscription_type } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(full ? { limit: windowLimit(full[0], full[1].resetsAt) } : {}),
  };
}

function parseResult(r: Obj, track: ClaudeTrack): FunnelEvent[] {
  const text = typeof r.result === "string" ? r.result : "";
  if (r.is_error === true || (typeof r.subtype === "string" && r.subtype.startsWith("error"))) {
    const status = r.api_error_status;
    const error: FunnelEvent = { type: "error", message: text || `Claude Code failed (${String(r.subtype)}).`, code: status ? String(status) : undefined };
    if (status !== 429) return [error];
    // A 429 is a limit. Running out of usage credits does not clear by waiting.
    const quota = /credit/i.test(String(r.api_error_code ?? ""));
    return [{ type: "limit", kind: quota ? "quota" : "rate", detail: text || "Claude Code hit a rate limit." }, error];
  }
  const events: FunnelEvent[] = [];
  if (isObj(r.usage)) {
    const u = r.usage;
    const cached = num(u.cache_read_input_tokens);
    // The API's `input_tokens` leaves out what was read from or written to the prompt cache, so both are added here.
    const written = num(u.cache_creation_input_tokens);
    const input = num(u.input_tokens) + cached + written;
    const thinking = isObj(u.output_tokens_details) ? num(u.output_tokens_details.thinking_tokens) : 0;
    const usage: Usage = {
      inputTokens: input,
      outputTokens: num(u.output_tokens),
      cachedInputTokens: cached,
      ...(written > 0 ? { cacheCreationInputTokens: written } : {}),
      // `output_tokens` already counts the thinking tokens.
      ...(thinking > 0 ? { reasoningTokens: thinking } : {}),
      totalTokens: input + num(u.output_tokens),
    };
    events.push({ type: "usage", usage });
  }
  if (r.structured_output !== undefined) events.push({ type: "structured", data: r.structured_output });
  const denials = Array.isArray(r.permission_denials) ? r.permission_denials.filter(isObj) : [];
  // The tool result only says the call failed. The denial list says why, so the call ends again as denied.
  for (const d of denials) {
    if (typeof d.tool_use_id === "string") {
      const sub = track.subagentCalls.get(d.tool_use_id);
      events.push({ type: "tool.end", id: d.tool_use_id, error: `denied: ${String(d.tool_name)} was not allowed`, ...sub });
    }
  }
  const finishReason: FinishReason = denials.length ? "denied" : "stop";
  events.push({ type: "done", text, finishReason });
  return events;
}
