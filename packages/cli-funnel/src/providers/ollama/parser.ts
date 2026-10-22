import type { EffortOption, FunnelEvent, ModelInfo, PullEvent, Usage } from "../../types.js";

type Json = Record<string, any>;

/** Embedding-only models. Older servers do not list `capabilities`, so the family and the name decide. */
const EMBEDDING_NAME = /embed|bge-|minilm|mxbai|\be5\b|gte-/i;

function embeddingOnly(m: Json): boolean {
  if (Array.isArray(m.capabilities)) return !m.capabilities.includes("completion");
  return /bert/i.test(String(m.details?.family ?? "")) || EMBEDDING_NAME.test(String(m.name));
}

const LEVELS: EffortOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

/**
 * Ollama's `think` is on or off for most models, so those get one level, `on`. The gpt-oss models take
 * `low`, `medium` and `high`. A model without the `thinking` capability gets none.
 */
function thinkingEfforts(model: Json): EffortOption[] {
  if (!Array.isArray(model.capabilities) || !model.capabilities.includes("thinking")) return [];
  return /^gpt-oss/.test(String(model.name)) ? LEVELS : [{ id: "on", label: "On" }];
}

/** The `think` value for a selected effort. */
export const thinkValue = (effort: string): boolean | string => (effort === "on" ? true : effort);

const CONTEXT_STEPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];

/** Context sizes to offer: doubling steps below the model's limit, then the limit. Empty when the server does not report it. */
function contextSizes(model: Json): number[] {
  const max = model.details?.context_length;
  if (typeof max !== "number" || !(max > 0)) return [];
  return [...CONTEXT_STEPS.filter((s) => s < max), max];
}

/** Ollama ids such as `llama3.2:latest` are passed through as the server reports them. The digest pins the weights. */
export function parseTags(body: unknown): ModelInfo[] {
  const models: Json[] = (body as Json)?.models ?? [];
  return models
    .filter((m) => typeof m.name === "string" && !embeddingOnly(m))
    .map((m) => ({
      id: m.name as string,
      name: m.digest ? `${m.name} (${String(m.digest).slice(0, 8)})` : m.name,
      provider: "ollama" as const,
      efforts: thinkingEfforts(m),
      contextWindows: contextSizes(m),
      fast: false,
      source: "cli" as const,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function toUsage(line: Json): Usage | undefined {
  if (line.prompt_eval_count === undefined && line.eval_count === undefined) return undefined;
  const inputTokens = line.prompt_eval_count ?? 0;
  const outputTokens = line.eval_count ?? 0;
  return { inputTokens, outputTokens, cachedInputTokens: line.prompt_eval_cached_count, totalTokens: inputTokens + outputTokens };
}

/** Maps one `/api/pull` stream line. `success` is the last line of a finished pull. */
export function mapPullLine(line: unknown): PullEvent | undefined {
  const l = line as Json;
  if (!l || typeof l !== "object" || "__raw" in l) return undefined;
  if (l.error) return { type: "error", message: String(l.error) };
  if (l.status === "success") return { type: "done" };
  if (typeof l.status !== "string") return undefined;
  return {
    type: "progress",
    status: l.status,
    ...(l.digest ? { digest: l.digest } : {}),
    ...(typeof l.total === "number" ? { total: l.total } : {}),
    ...(typeof l.completed === "number" ? { completed: l.completed } : {}),
  };
}

/**
 * Maps one `/api/chat` stream line to events. The final line (`done: true`) carries the token counts. Tool calls
 * arrive whole, with arguments as an object. A call without an id gets an empty one, for the provider to fill.
 */
export function mapChatLine(line: unknown): FunnelEvent[] {
  const l = line as Json;
  if (!l || typeof l !== "object" || "__raw" in l) return [];
  if (l.error) return [{ type: "error", message: String(l.error), code: "cli-failed" }];
  const events: FunnelEvent[] = [];
  if (l.message?.thinking) events.push({ type: "reasoning.delta", text: l.message.thinking });
  if (l.message?.content) events.push({ type: "text.delta", text: l.message.content });
  for (const c of Array.isArray(l.message?.tool_calls) ? l.message.tool_calls : []) {
    if (typeof c?.function?.name !== "string") continue;
    events.push({ type: "tool_call", id: typeof c.id === "string" ? c.id : "", name: c.function.name, input: c.function.arguments ?? {} });
  }
  if (l.done) {
    const usage = toUsage(l);
    if (usage) events.push({ type: "usage", usage });
    events.push({ type: "done", text: "", finishReason: l.done_reason === "length" ? "length" : "stop" });
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
