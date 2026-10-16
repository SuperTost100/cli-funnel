import type { FinishReason, FunnelEvent, Usage } from "../../types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" ? v : 0);

function toolOutput(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((c) => (isObj(c) && typeof c.text === "string" ? [c.text] : []));
  return text.length ? text.join("\n") : undefined;
}

/**
 * Text blocks of a subagent's `assistant` message, which Claude Code sends with `--forward-subagent-text`. Thinking
 * blocks are left out: the CLI sends them empty. The subagent's prompt (a `user` message) and its tool calls are left
 * out too. The parent's `Agent` tool call already carries the prompt.
 */
function subagentText(raw: Obj): FunnelEvent[] {
  if (raw.type !== "assistant" || typeof raw.parent_tool_use_id !== "string" || !isObj(raw.message) || !Array.isArray(raw.message.content)) return [];
  const agent = typeof raw.subagent_type === "string" ? raw.subagent_type : undefined;
  return raw.message.content.flatMap((b): FunnelEvent[] =>
    isObj(b) && b.type === "text" && typeof b.text === "string" && b.text
      ? [{ type: "subagent.text", parentId: raw.parent_tool_use_id as string, text: b.text, ...(agent ? { agent } : {}) }]
      : [],
  );
}

/**
 * Maps one stream-json object from `claude -p` to zero or more FunnelEvents. Stateless. Messages from subagents are
 * dropped unless `forwardSubagents` is set, which goes with the `--forward-subagent-text` flag.
 */
export function parseClaudeMessage(raw: unknown, forwardSubagents = false): FunnelEvent[] {
  if (!isObj(raw)) return [];
  const type = raw.type;

  if (type === "system" && raw.subtype === "init" && typeof raw.session_id === "string") {
    return [{ type: "session", sessionId: raw.session_id, model: typeof raw.model === "string" ? raw.model : undefined }];
  }

  if (type === "rate_limit_event" && isObj(raw.rate_limit_info)) return parseRateLimit(raw.rate_limit_info);

  // Subagent traffic carries a parent id. The main thread is surfaced as it is, the subagents' text only on request.
  if (raw.parent_tool_use_id) return forwardSubagents ? subagentText(raw) : [];

  if (type === "stream_event" && isObj(raw.event) && raw.event.type === "content_block_delta" && isObj(raw.event.delta)) {
    const d = raw.event.delta;
    if (d.type === "text_delta" && typeof d.text === "string") return [{ type: "text.delta", text: d.text }];
    if (d.type === "thinking_delta" && typeof d.thinking === "string") return [{ type: "reasoning.delta", text: d.thinking }];
    return [];
  }

  // Text and thinking arrive as deltas. Complete assistant messages are only used for tool calls.
  if (type === "assistant" && isObj(raw.message) && Array.isArray(raw.message.content)) {
    return raw.message.content.flatMap((b): FunnelEvent[] =>
      isObj(b) && b.type === "tool_use" && typeof b.id === "string"
        ? [{ type: "tool.start", id: b.id, name: String(b.name), input: b.input }]
        : [],
    );
  }

  if (type === "user" && isObj(raw.message) && Array.isArray(raw.message.content)) {
    return raw.message.content.flatMap((b): FunnelEvent[] => {
      if (!isObj(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") return [];
      const out = toolOutput(b.content);
      return [
        b.is_error === true
          ? { type: "tool.end", id: b.tool_use_id, error: out ?? "Tool failed." }
          : { type: "tool.end", id: b.tool_use_id, output: out },
      ];
    });
  }

  if (type === "result") return parseResult(raw);
  return [];
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
  const name = (window && WINDOWS[window]) ?? "usage";
  const resetAt = typeof info.resetsAt === "number" ? new Date(info.resetsAt * 1000).toISOString() : undefined;
  return [{ type: "limit", kind: window === "five_hour" ? "rate" : "quota", detail: `Claude ${name} limit reached.`, ...(resetAt ? { resetAt } : {}) }];
}

function parseResult(r: Obj): FunnelEvent[] {
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
    const input = num(u.input_tokens) + cached + num(u.cache_creation_input_tokens);
    const usage: Usage = {
      inputTokens: input,
      outputTokens: num(u.output_tokens),
      cachedInputTokens: cached,
      totalTokens: input + num(u.output_tokens),
    };
    events.push({ type: "usage", usage });
  }
  if (r.structured_output !== undefined) events.push({ type: "structured", data: r.structured_output });
  const denials = Array.isArray(r.permission_denials) ? r.permission_denials.filter(isObj) : [];
  // The tool result only says the call failed. The denial list says why, so the call ends again as denied.
  for (const d of denials) {
    if (typeof d.tool_use_id === "string") events.push({ type: "tool.end", id: d.tool_use_id, error: `denied: ${String(d.tool_name)} was not allowed` });
  }
  const finishReason: FinishReason = denials.length ? "denied" : "stop";
  events.push({ type: "done", text, finishReason });
  return events;
}
