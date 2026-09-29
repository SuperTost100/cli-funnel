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

/** Maps one stream-json object from `claude -p` to zero or more FunnelEvents. Stateless. */
export function parseClaudeMessage(raw: unknown): FunnelEvent[] {
  if (!isObj(raw)) return [];
  const type = raw.type;

  if (type === "system" && raw.subtype === "init" && typeof raw.session_id === "string") {
    return [{ type: "session", sessionId: raw.session_id, model: typeof raw.model === "string" ? raw.model : undefined }];
  }

  // Subagent traffic carries a parent id. Only the main thread is surfaced.
  if (raw.parent_tool_use_id) return [];

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

function parseResult(r: Obj): FunnelEvent[] {
  const text = typeof r.result === "string" ? r.result : "";
  if (r.is_error === true || (typeof r.subtype === "string" && r.subtype.startsWith("error"))) {
    const status = r.api_error_status;
    return [{ type: "error", message: text || `Claude Code failed (${String(r.subtype)}).`, code: status ? String(status) : undefined }];
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
  const denied = Array.isArray(r.permission_denials) && r.permission_denials.length > 0;
  const finishReason: FinishReason = denied ? "denied" : "stop";
  events.push({ type: "done", text, finishReason });
  return events;
}
