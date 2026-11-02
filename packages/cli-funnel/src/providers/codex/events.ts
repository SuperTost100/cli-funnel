import { isAbsolute, resolve } from "node:path";
import type { FileChange, FunnelEvent, PlanStep, Usage } from "../../types.js";

type Params = Record<string, any>;
type LimitEvent = Extract<FunnelEvent, { type: "limit" }>;

/** Windows up to five hours count as a rate limit. Longer windows count as a quota. */
const RATE_WINDOW_MINS = 300;

const REACHED: Record<string, string> = {
  workspace_owner_credits_depleted: "Codex workspace credits are used up.",
  workspace_member_credits_depleted: "Codex workspace credits are used up.",
  workspace_owner_usage_limit_reached: "Codex workspace usage limit reached.",
  workspace_member_usage_limit_reached: "Codex workspace usage limit reached.",
};

/** A limit from `codexErrorInfo` on an error. Other error kinds give none. */
function errorLimit(error: Params | undefined): LimitEvent[] {
  const info = error?.codexErrorInfo;
  if (info !== "usageLimitExceeded" && info !== "rateLimitExceeded") return [];
  return [{ type: "limit", kind: info === "usageLimitExceeded" ? "quota" : "rate", detail: error?.message ?? "Codex hit a usage limit." }];
}

/** A limit from an `account/rateLimits/updated` snapshot, when it says one was reached. Usage below 100% gives none. */
export function snapshotLimit(snapshot: Params | undefined): LimitEvent[] {
  if (!snapshot) return [];
  const windows = [snapshot.primary, snapshot.secondary].filter((w): w is Params => !!w);
  const full = windows.find((w) => w.usedPercent >= 100);
  const reached: string | undefined = snapshot.rateLimitReachedType ?? undefined;
  if (!full && !reached) return [];
  const window = full ?? windows[0];
  const shortWindow = typeof window?.windowDurationMins === "number" && window.windowDurationMins <= RATE_WINDOW_MINS;
  const kind = reached && reached !== "rate_limit_reached" ? "quota" : shortWindow ? "rate" : "quota";
  const limit: LimitEvent = { type: "limit", kind, detail: (reached && REACHED[reached]) ?? "Codex usage limit reached." };
  if (typeof window?.resetsAt === "number") limit.resetAt = new Date(window.resetsAt * 1000).toISOString();
  return [limit];
}

const STEP_STATUS: Record<string, PlanStep["status"]> = { pending: "pending", inProgress: "in_progress", completed: "done" };

/** A `turn/plan/updated` notification as a `plan` event. A step with an unknown status counts as pending. */
export function planEvent(p: Params): FunnelEvent {
  const steps: PlanStep[] = (Array.isArray(p.plan) ? p.plan : []).map((s: Params) => ({ text: String(s?.step ?? ""), status: STEP_STATUS[s?.status] ?? "pending" }));
  return p.explanation ? { type: "plan", steps, explanation: p.explanation } : { type: "plan", steps };
}

const CHANGE_STATUS: Record<string, FileChange["status"]> = { completed: "done", failed: "failed", declined: "declined" };

/**
 * One `file.change` event per entry of a finished `fileChange` item. Codex sends absolute paths. A relative one is
 * resolved against the thread's working directory. An item that has not finished gives none.
 */
export function fileChangeEvents(item: Params, cwd: string): FunnelEvent[] {
  const status = CHANGE_STATUS[item?.status];
  if (!status || !Array.isArray(item.changes)) return [];
  const abs = (path: string) => (isAbsolute(path) ? path : resolve(cwd, path));
  return item.changes.flatMap((c: Params): FunnelEvent[] => {
    const kind = c?.kind?.type;
    if (typeof c?.path !== "string" || (kind !== "add" && kind !== "update" && kind !== "delete")) return [];
    const e: Extract<FunnelEvent, { type: "file.change" }> = { type: "file.change", id: item.id, path: abs(c.path), kind, status };
    if (kind === "update" && typeof c.kind.move_path === "string") e.movedTo = abs(c.kind.move_path);
    return [e];
  });
}

/** An MCP tool call in progress, kept so its approval request can name the tool. */
export interface McpCall {
  id: string;
  server: string;
  tool: string;
  arguments: unknown;
}

/** Which subagent work to turn into events. Both default to off. */
export interface ForwardSubagents {
  text?: boolean;
  tools?: boolean;
}

/** The subagent a thread belongs to: the id of the item that started it, and its name when Codex gives one. */
interface Subagent {
  parentId: string;
  agent?: string;
}

/** The last part of a subagent's `agentPath`, such as `list_files` for `/root/list_files`. */
const agentName = (path: unknown): string | undefined => (typeof path === "string" ? path.split("/").filter(Boolean).at(-1) : undefined);

export interface Translated {
  events: FunnelEvent[];
  /** Set when the turn is over. */
  finished?: boolean;
}

/** Maps app-server notifications for one thread to funnel events. */
export class Translator {
  /** File changes by item id, kept so approval requests can show them. */
  readonly items = new Map<string, unknown>();
  /** MCP tool calls in flight, by item id. Codex asks to approve a call after its `item/started`, and calls can overlap. */
  readonly mcpCalls = new Map<string, McpCall>();
  private messages: string[] = [];
  private usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  /** Codex sends a rate-limit snapshot after every turn. A reached limit is reported once per run. */
  private limitReported = false;
  /** Subagent threads by thread id. Their notifications carry their own thread id. */
  private readonly subagents = new Map<string, Subagent>();

  /**
   * `cwd` is the thread's working directory, for file change paths that are not absolute. `forward` picks the subagent
   * work that becomes events: their tool calls as `tool.start` and `tool.end` with `parentId`, and their messages as
   * `subagent.text`.
   */
  constructor(
    private threadId: string,
    private cwd: string = process.cwd(),
    private readonly forward: ForwardSubagents = {},
  ) {}

  handle(method: string, p: Params = {}): Translated {
    if (p.threadId && p.threadId !== this.threadId) return { events: this.fromSubagent(method, p) };
    switch (method) {
      case "item/agentMessage/delta":
        // Commentary is a note to the user between tool calls, the same as Claude Code's text between tool calls, so it
        // streams as text. It stays out of `done.text` (see itemCompleted), which holds only the final message.
        return { events: [{ type: "text.delta", text: p.delta }] };
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return { events: [{ type: "reasoning.delta", text: p.delta }] };
      case "item/started":
        return { events: this.itemStarted(p.item) };
      case "item/completed":
        return { events: this.itemCompleted(p.item) };
      case "thread/tokenUsage/updated": {
        const l = p.tokenUsage?.last;
        if (!l) return { events: [] };
        const u = this.usage;
        u.inputTokens += l.inputTokens;
        u.outputTokens += l.outputTokens;
        u.cachedInputTokens = (u.cachedInputTokens ?? 0) + l.cachedInputTokens;
        u.reasoningTokens = (u.reasoningTokens ?? 0) + l.reasoningOutputTokens;
        u.totalTokens += l.totalTokens;
        return { events: [{ type: "usage", usage: { ...u } }] };
      }
      case "account/rateLimits/updated": {
        if (this.limitReported) return { events: [] };
        const events = snapshotLimit(p.rateLimits);
        this.limitReported = events.length > 0;
        return { events };
      }
      case "error":
        // Codex retries some errors itself. A limit is still worth reporting then.
        if (p.willRetry) return { events: errorLimit(p.error) };
        return { events: [...errorLimit(p.error), { type: "error", message: p.error?.message ?? "Codex reported an error." }], finished: true };
      case "turn/plan/updated":
        return { events: [planEvent(p)] };
      case "turn/completed":
        return this.turnCompleted(p.turn);
      default:
        return { events: [] };
    }
  }

  /**
   * A notification from another thread. Only the threads of this thread's subagents count, and only their items: their
   * turns, usage and messages never end or change this turn. Their file changes and plans are left out too, so they
   * do not count as the run's own.
   */
  private fromSubagent(method: string, p: Params): FunnelEvent[] {
    const sub = this.subagents.get(p.threadId);
    if (!sub || (method !== "item/started" && method !== "item/completed")) return [];
    const tag = <E extends FunnelEvent>(e: E): E => ({ ...e, parentId: sub.parentId, ...(sub.agent ? { agent: sub.agent } : {}) });
    // A subagent can start subagents of its own. itemStarted and itemCompleted note them, and without tool events
    // they are noted here, so text forwarding alone still follows them.
    if (!this.forward.tools) this.trackSubagent(p.item);
    if (method === "item/started") return this.forward.tools ? this.itemStarted(p.item).filter((e) => e.type === "tool.start").map(tag) : [];
    if (p.item?.type === "agentMessage") {
      return this.forward.text && p.item.text ? [{ type: "subagent.text", parentId: sub.parentId, text: String(p.item.text), ...(sub.agent ? { agent: sub.agent } : {}) }] : [];
    }
    return this.forward.tools ? this.itemCompleted(p.item).filter((e) => e.type === "tool.end").map(tag) : [];
  }

  /** Remembers which item started a subagent thread, so the thread's items can name it as their parent. */
  private trackSubagent(item: Params): void {
    if (item?.type === "subAgentActivity" && item.kind === "started" && typeof item.agentThreadId === "string") {
      this.subagents.set(item.agentThreadId, { parentId: String(item.id), ...(agentName(item.agentPath) ? { agent: agentName(item.agentPath) } : {}) });
    }
    // Codex before 0.166 named the new threads in a `spawnAgent` collab call once it completed.
    if (item?.type === "collabAgentToolCall" && item.tool === "spawnAgent" && Array.isArray(item.receiverThreadIds)) {
      for (const thread of item.receiverThreadIds) if (typeof thread === "string") this.subagents.set(thread, { parentId: String(item.id) });
    }
  }

  private itemStarted(item: Params): FunnelEvent[] {
    this.trackSubagent(item);
    switch (item?.type) {
      case "commandExecution":
        return [{ type: "tool.start", id: item.id, name: "command", input: { command: item.command, cwd: item.cwd } }];
      case "fileChange":
        this.items.set(item.id, item.changes);
        return [{ type: "tool.start", id: item.id, name: "file_change", input: { changes: item.changes } }];
      case "mcpToolCall":
        this.mcpCalls.set(item.id, { id: item.id, server: item.server, tool: item.tool, arguments: item.arguments });
        return [{ type: "tool.start", id: item.id, name: `mcp:${item.server}/${item.tool}`, input: item.arguments }];
      case "dynamicToolCall":
        return [{ type: "tool.start", id: item.id, name: item.tool, input: item.arguments }];
      case "webSearch":
        return [{ type: "tool.start", id: item.id, name: "web_search", input: { query: item.query, action: item.action ?? undefined } }];
      case "imageView":
        return [{ type: "tool.start", id: item.id, name: "image_view", input: { path: item.path } }];
      case "collabAgentToolCall":
        return [{ type: "tool.start", id: item.id, name: `agent:${item.tool}`, input: { prompt: item.prompt ?? undefined, model: item.model ?? undefined, receiverThreadIds: item.receiverThreadIds } }];
      case "subAgentActivity":
        // Codex 0.166 reports a spawned subagent this way. A `completed` activity says it finished: nothing to start.
        if (item.kind !== "started") return [];
        return [{ type: "tool.start", id: item.id, name: "agent:spawnAgent", input: { agent: item.agentPath ?? undefined, model: item.model ?? undefined, threadId: item.agentThreadId } }];
      default:
        return [];
    }
  }

  private itemCompleted(item: Params): FunnelEvent[] {
    this.trackSubagent(item);
    switch (item?.type) {
      case "agentMessage":
        // Only the final answer, or a message from an older Codex that sets no phase, is result text. Commentary
        // already streamed as text.delta.
        if (item.text && item.phase !== "commentary") this.messages.push(item.text);
        return [];
      case "commandExecution": {
        const bad = item.status === "failed" || item.status === "declined" || (item.exitCode ?? 0) !== 0;
        const code = item.exitCode != null ? ` (exit ${item.exitCode})` : "";
        const error = bad ? `${item.status === "declined" ? "denied: " : ""}Command ${item.status}${code}` : undefined;
        return [{ type: "tool.end", id: item.id, output: item.aggregatedOutput ?? undefined, error }];
      }
      case "fileChange": {
        const bad = item.status === "failed" || item.status === "declined";
        const error = bad ? `${item.status === "declined" ? "denied: " : ""}File change ${item.status}` : undefined;
        return [...fileChangeEvents(item, this.cwd), { type: "tool.end", id: item.id, error }];
      }
      case "mcpToolCall": {
        this.mcpCalls.delete(item.id);
        const error = item.error?.message ?? (item.status === "failed" ? "MCP tool call failed" : undefined);
        const out = item.result ? JSON.stringify(item.result.structuredContent ?? item.result.content) : undefined;
        return [{ type: "tool.end", id: item.id, output: out, error }];
      }
      case "dynamicToolCall":
        return [{ type: "tool.end", id: item.id, error: item.success === false ? "Tool call failed" : undefined }];
      case "webSearch":
        return [{ type: "tool.end", id: item.id, output: item.results ? JSON.stringify(item.results) : undefined }];
      case "imageView":
        return [{ type: "tool.end", id: item.id }];
      case "collabAgentToolCall": {
        const bad = item.status === "failed" || item.status === "interrupted";
        return [{ type: "tool.end", id: item.id, error: bad ? `Agent call ${item.status}` : undefined }];
      }
      case "subAgentActivity":
        return item.kind === "started" ? [{ type: "tool.end", id: item.id }] : [];
      default:
        return [];
    }
  }

  private turnCompleted(turn: Params): Translated {
    if (turn?.status === "failed") {
      return { events: [...errorLimit(turn.error), { type: "error", message: turn.error?.message ?? "Turn failed." }], finished: true };
    }
    const finishReason = turn?.status === "interrupted" ? "cancelled" : "stop";
    return { events: [{ type: "done", text: this.messages.join("\n\n"), finishReason }], finished: true };
  }
}
