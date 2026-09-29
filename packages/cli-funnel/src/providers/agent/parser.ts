import { FunnelError, type AuthStatus, type EffortOption, type FunnelEvent, type ModelInfo, type Selection, type Usage } from "../../types.js";

export interface ListedModel {
  id: string;
  name: string;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_LABEL: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};
const EFFORT_WORDS = /\b(?:Minimal|None|Low|Medium|High|Extra High|Max)\b/g;

/** Parses `agent --list-models`. The "auto" alias is dropped: only concrete ids are selectable. */
export function parseModelList(text: string): ListedModel[] {
  const out: ListedModel[] = [];
  for (const raw of text.replace(/[​-‍﻿]/g, "").split("\n")) {
    const m = raw.match(/^([a-z0-9][\w.-]*) - (.+)$/i);
    if (m?.[1] && m[2] && m[1] !== "auto") out.push({ id: m[1], name: m[2].trim() });
  }
  return out;
}

interface Parts {
  base: string;
  thinking: boolean;
  effort?: string;
  fast: boolean;
  bare: boolean;
}

/** Splits a flat CLI id into base model, effort and fast tier. "thinking" stays part of the base. */
function splitId(id: string): Parts {
  let tokens = id.split("-");
  let fast = false;
  let thinking = false;
  let effort: string | undefined;
  if (tokens.length > 1 && tokens[tokens.length - 1] === "fast") {
    fast = true;
    tokens = tokens.slice(0, -1);
  }
  const dropThinking = () => {
    if (tokens[tokens.length - 1] === "thinking") {
      thinking = true;
      tokens = tokens.slice(0, -1);
    }
  };
  dropThinking();
  const tail = tokens.slice(-2).join("-");
  if (tail === "extra-high") {
    effort = "xhigh";
    tokens = tokens.slice(0, -2);
  } else if (EFFORT_ORDER.includes(tokens[tokens.length - 1] ?? "")) {
    effort = tokens[tokens.length - 1]!;
    tokens = tokens.slice(0, -1);
  }
  dropThinking();
  const stem = tokens.join("-");
  return { base: thinking ? `${stem}-thinking` : stem, thinking, effort, fast, bare: effort === undefined };
}

/** Groups the flat variant list into base models with efforts and a fast flag. */
export function groupModels(listed: ListedModel[]): ModelInfo[] {
  const groups = new Map<string, { name: string; efforts: Set<string>; fast: boolean; bare: boolean }>();
  for (const { id, name } of listed) {
    const p = splitId(id);
    const g = groups.get(p.base) ?? { name: "", efforts: new Set<string>(), fast: false, bare: false };
    const clean = name.replace(EFFORT_WORDS, "").replace(/\bFast\b/g, "").replace(/\s+/g, " ").trim();
    if (!g.name || clean.length < g.name.length) g.name = clean;
    if (p.effort) g.efforts.add(p.effort);
    if (p.fast) g.fast = true;
    if (p.bare) g.bare = true;
    groups.set(p.base, g);
  }
  const models: ModelInfo[] = [];
  for (const [id, g] of groups) {
    // ponytail: a bare id next to effort variants is the medium tier on gpt-* only; other families have no bare-plus-effort mix
    if (g.bare && g.efforts.size && id.startsWith("gpt-")) g.efforts.add("medium");
    const efforts: EffortOption[] = EFFORT_ORDER.filter((e) => g.efforts.has(e)).map((e) => ({ id: e, label: EFFORT_LABEL[e] ?? e }));
    const defaultEffort = ["medium", "high"].find((e) => g.efforts.has(e)) ?? efforts[0]?.id;
    models.push({
      id,
      name: g.name,
      provider: "agent",
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      contextWindows: [],
      fast: g.fast,
      source: "cli",
    });
  }
  return models;
}

/** Builds the exact `--model` value. `known` is the set of flat ids from `--list-models`. */
export function toCliModel(selection: Pick<Selection, "model" | "effort" | "fast">, known: ReadonlySet<string> = new Set()): string {
  const thinking = selection.model.endsWith("-thinking");
  const stem = thinking ? selection.model.slice(0, -"-thinking".length) : selection.model;
  const efforts = selection.effort
    ? [selection.effort]
    : ["", "medium", "high", "low", "xhigh", "max", "minimal", "none"];
  const candidates: string[] = [];
  for (const e of efforts) {
    const tokens = e === "xhigh" ? ["xhigh", "extra-high"] : [e];
    for (const t of tokens) {
      const parts = thinking
        ? [t ? `${stem}-thinking-${t}` : `${stem}-thinking`, ...(t ? [`${stem}-${t}-thinking`] : [])]
        : [t ? `${stem}-${t}` : stem];
      for (const p of parts) candidates.push(selection.fast ? `${p}-fast` : p);
    }
    // ponytail: gpt-* medium tier is the bare id
    if (e === "medium" && stem.startsWith("gpt-")) candidates.push(selection.fast ? `${selection.model}-fast` : selection.model);
  }
  if (!known.size) return candidates[0]!;
  const hit = candidates.find((c) => known.has(c));
  if (!hit) {
    throw new FunnelError(
      `Cursor Agent has no variant of ${selection.model} with effort ${selection.effort ?? "default"}${selection.fast ? " and fast tier" : ""}.`,
      "invalid-selection",
    );
  }
  return hit;
}

export function parseStatus(json: string, aboutJson?: string): AuthStatus {
  let s: { isAuthenticated?: boolean; userInfo?: { email?: string } };
  try {
    s = JSON.parse(json);
  } catch {
    return { loggedIn: /logged in/i.test(json) && !/not logged in/i.test(json), account: json.match(/Logged in as (\S+)/i)?.[1] };
  }
  const status: AuthStatus = { loggedIn: s.isAuthenticated === true, method: "Cursor", account: s.userInfo?.email };
  if (aboutJson) {
    try {
      const plan = JSON.parse(aboutJson).subscriptionTier;
      if (typeof plan === "string") status.plan = plan;
    } catch {
      /* plan is optional */
    }
  }
  return status;
}

function toolName(key: string): string {
  return key.replace(/ToolCall$/, "");
}

function toolInput(name: string, args: Record<string, unknown> | undefined): unknown {
  if (!args) return undefined;
  if (name === "shell") return { command: args.command, workingDirectory: args.workingDirectory || undefined };
  return args;
}

function failure(result: Record<string, unknown> | undefined): string | undefined {
  if (!result || "success" in result) return undefined;
  const e = (result.error ?? result.failure ?? result.rejected ?? result.permissionDenied) as Record<string, unknown> | undefined;
  const msg = e && (e.errorMessage ?? e.message ?? e.reason);
  return typeof msg === "string" ? msg : JSON.stringify(result).slice(0, 300);
}

function output(result: Record<string, unknown> | undefined): string | undefined {
  const s = result?.success as Record<string, unknown> | undefined;
  if (!s) return undefined;
  for (const k of ["stdout", "content", "message"]) if (typeof s[k] === "string") return s[k] as string;
  return undefined;
}

export function toUsage(u: Record<string, number> | undefined): Usage | undefined {
  if (!u) return undefined;
  const cached = u.cacheReadTokens ?? 0;
  const inputTokens = (u.inputTokens ?? 0) + cached + (u.cacheWriteTokens ?? 0);
  const outputTokens = u.outputTokens ?? 0;
  return { inputTokens, outputTokens, cachedInputTokens: cached, totalTokens: inputTokens + outputTokens };
}

/** Turns stream-json lines into FunnelEvents. Feed each parsed line to `map`. */
export class StreamMapper {
  private sawPartial = false;
  private text = "";
  private denied = false;
  private started = new Map<string, string>();

  map(line: unknown): FunnelEvent[] {
    const m = line as Record<string, any>;
    if (!m || typeof m !== "object" || "__raw" in m) return [];
    switch (m.type) {
      case "system":
        return m.subtype === "init" && m.session_id ? [{ type: "session", sessionId: m.session_id }] : [];
      case "thinking":
        return m.subtype === "delta" && m.text ? [{ type: "reasoning.delta", text: m.text }] : [];
      case "assistant": {
        // Partial deltas carry timestamp_ms; the aggregated repeat of a segment does not.
        const partial = m.timestamp_ms !== undefined;
        if (partial) this.sawPartial = true;
        else if (this.sawPartial) return [];
        const text = (m.message?.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("");
        if (!text) return [];
        this.text += text;
        return [{ type: "text.delta", text }];
      }
      case "tool_call": {
        const key = Object.keys(m.tool_call ?? {})[0];
        if (!key) return [];
        const call = m.tool_call[key];
        const name = toolName(key);
        const id = String(m.call_id ?? call.toolCallId ?? name);
        if (m.subtype === "started") {
          this.started.set(id, name);
          return [{ type: "tool.start", id, name, input: toolInput(name, call.args) }];
        }
        if (m.subtype === "completed") {
          const error = failure(call.result);
          if (error && call.result && ("rejected" in call.result || "permissionDenied" in call.result)) this.denied = true;
          return [{ type: "tool.end", id, ...(error ? { error } : { output: output(call.result) }) }];
        }
        return [];
      }
      case "result": {
        const events: FunnelEvent[] = [];
        if (m.is_error || m.subtype !== "success") {
          return [{ type: "error", message: String(m.result ?? m.subtype ?? "Cursor Agent failed") }];
        }
        const usage = toUsage(m.usage);
        if (usage) events.push({ type: "usage", usage });
        events.push({ type: "done", text: typeof m.result === "string" ? m.result : this.text, finishReason: this.denied ? "denied" : "stop" });
        return events;
      }
      default:
        return [];
    }
  }
}
