import type { FunnelEvent, ModelInfo, Usage } from "../../types.js";

type Json = Record<string, any>;

/** Ollama ids such as `llama3.2:latest` are passed through as the server reports them. The digest pins the weights. */
export function parseTags(body: unknown): ModelInfo[] {
  const models: Json[] = (body as Json)?.models ?? [];
  return models
    .filter((m) => typeof m.name === "string" && !(m.capabilities && !m.capabilities.includes("completion")))
    .map((m) => ({
      id: m.name as string,
      name: m.digest ? `${m.name} (${String(m.digest).slice(0, 8)})` : m.name,
      provider: "ollama" as const,
      efforts: [],
      contextWindows: [],
      fast: false,
      source: "cli" as const,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function toUsage(line: Json): Usage | undefined {
  if (line.prompt_eval_count === undefined && line.eval_count === undefined) return undefined;
  const inputTokens = line.prompt_eval_count ?? 0;
  const outputTokens = line.eval_count ?? 0;
  return { inputTokens, outputTokens, cachedInputTokens: line.prompt_eval_cached_count, totalTokens: inputTokens + outputTokens };
}

/** Maps one `/api/chat` stream line to events. The final line (`done: true`) carries the token counts. */
export function mapChatLine(line: unknown): FunnelEvent[] {
  const l = line as Json;
  if (!l || typeof l !== "object" || "__raw" in l) return [];
  if (l.error) return [{ type: "error", message: String(l.error), code: "cli-failed" }];
  const events: FunnelEvent[] = [];
  if (l.message?.thinking) events.push({ type: "reasoning.delta", text: l.message.thinking });
  if (l.message?.content) events.push({ type: "text.delta", text: l.message.content });
  if (l.done) {
    const usage = toUsage(l);
    if (usage) events.push({ type: "usage", usage });
    events.push({ type: "done", text: "", finishReason: "stop" });
  }
  return events;
}

/**
 * Normalizes a base URL or an `OLLAMA_HOST` value. Like Ollama itself, a value without a scheme means http and a value
 * without a port means 11434, so `0.0.0.0` becomes `http://127.0.0.1:11434`. A full URL keeps its own port.
 */
export function normalizeBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, "");
  const hasScheme = /^https?:\/\//.test(raw);
  const url = new URL(hasScheme ? raw : `http://${raw}`);
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (!hasScheme && !/:\d+(\/|$)/.test(raw)) url.port = "11434";
  return url.toString().replace(/\/+$/, "");
}
