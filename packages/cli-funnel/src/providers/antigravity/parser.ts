import type { EffortOption, FunnelEvent, ModelInfo, Usage } from "../../types.js";

const EFFORTS = ["low", "medium", "high", "max"];
const EFFORT_RE = /^(.+)-(low|medium|high|max)$/;

/** Parses `agy models` output (`id<TAB>Name` lines). Ids that differ only by an effort suffix become one model. */
export function parseModels(text: string): ModelInfo[] {
  const rows: { id: string; name: string; base: string; effort?: string }[] = [];
  for (const line of text.split("\n")) {
    const [rawId = "", rawName = ""] = line.split("\t");
    const id = rawId.trim();
    if (!id || id.includes(" ") || !rawName.trim()) continue;
    const m = EFFORT_RE.exec(id);
    rows.push({ id, name: rawName.trim(), base: m?.[1] ?? id, effort: m?.[2] });
  }
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r.base, [...(groups.get(r.base) ?? []), r]);
  const out: ModelInfo[] = [];
  for (const [base, members] of groups) {
    const first = members[0];
    if (!first) continue;
    const base0 = { provider: "antigravity" as const, contextWindows: [], fast: false, source: "cli" as const };
    if (members.length < 2 || members.some((x) => !x.effort)) {
      for (const r of members) out.push({ ...base0, id: r.id, name: r.name, efforts: [] });
      continue;
    }
    const efforts = members.map((x) => x.effort as string).sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
    out.push({
      ...base0,
      id: base,
      name: first.name.replace(/\s*\([^)]*\)\s*$/, ""),
      efforts: efforts.map((id): EffortOption => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) })),
      defaultEffort: efforts.includes("high") ? "high" : efforts[0],
    });
  }
  return out;
}

type Json = Record<string, any>;

function toUsage(u: Json | undefined): Usage | undefined {
  if (!u) return undefined;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: u.cache_read_tokens || undefined,
    reasoningTokens: u.thinking_tokens || undefined,
    totalTokens: u.total_tokens ?? input + output,
  };
}

/** Stateful mapper from one `agy --output-format stream-json` line to zero or more FunnelEvents. */
export function createMapper() {
  const started = new Set<string>();
  let deniedSeen = 0;
  let finished = false;

  return {
    get finished() {
      return finished;
    },
    map(line: unknown): FunnelEvent[] {
      const o = line as Json;
      if (!o || typeof o !== "object") return [];
      if (o.event === "init") {
        const id = o.conversation_id;
        return id ? [{ type: "session", sessionId: id, model: o.init?.model }] : [];
      }
      if (o.event === "step_update") {
        const s = o.step_update as Json;
        if (s.step_type === "agent_response") {
          return s.text_delta ? [{ type: "text.delta", text: s.text_delta }] : [];
        }
        if (s.step_type !== "tool") return [];
        const id = `${s.conversation_id}:${s.step_index}`;
        const name = s.tool_name ?? s.tool_info?.name ?? "tool";
        const events: FunnelEvent[] = [];
        if (!started.has(id)) {
          started.add(id);
          events.push({ type: "tool.start", id, name, input: s.tool_info?.parameters });
        }
        if (s.state === "DONE") events.push({ type: "tool.end", id });
        if (s.state === "ERROR") {
          const msg = String(s.tool_info?.error?.message ?? "tool failed").split("\n")[0] ?? "tool failed";
          const denied = /denied permission|permission check failed/i.test(msg);
          if (denied) deniedSeen++;
          events.push({ type: "tool.end", id, error: denied ? `denied: ${msg}` : msg });
        }
        return events;
      }
      if (o.event === "result") {
        finished = true;
        const r = o.result as Json;
        if (r.status === "ERROR" || r.error) {
          return [{ type: "error", message: String(r.error ?? "Antigravity run failed."), code: "cli-failed" }];
        }
        const events: FunnelEvent[] = [];
        const denied: Json[] = r.denied_actions ?? [];
        denied.slice(deniedSeen).forEach((d, i) => {
          const id = `denied:${i}`;
          const name = d.display_name ?? d.action;
          events.push({ type: "tool.start", id, name });
          events.push({ type: "tool.end", id, error: `denied: ${d.action} needs permission that headless mode cannot ask for` });
        });
        const usage = toUsage(r.usage);
        if (usage) events.push({ type: "usage", usage });
        const text = r.response ?? "";
        events.push({ type: "done", text, finishReason: denied.length && !text.trim() ? "denied" : "stop" });
        return events;
      }
      return [];
    },
  };
}
