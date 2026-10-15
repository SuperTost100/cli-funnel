import type { FunnelEvent, Limit } from "../types.js";
import { retryAfterMs } from "./http.js";

type LimitEvent = Extract<FunnelEvent, { type: "limit" }>;

/** "30s", "1.5s", "6m0s", "200ms" or "1h2m3s" in milliseconds. OpenAI and Gemini write durations like this. */
export function parseDuration(text: string): number | undefined {
  const parts = [...text.trim().matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (!parts.length || parts.map((p) => p[0]).join("") !== text.trim()) return undefined;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  return Math.round(parts.reduce((sum, p) => sum + Number(p[1]) * unit[p[2] as keyof typeof unit], 0));
}

/** `retry-after-ms` is milliseconds. `retry-after` is seconds or an HTTP date. */
function retryAfter(headers: Headers, now: number): number | undefined {
  const ms = Number(headers.get("retry-after-ms") ?? NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  return retryAfterMs(headers.get("retry-after"), now);
}

/**
 * When the exhausted limit resets. Anthropic sends `anthropic-ratelimit-<name>-reset` as a timestamp, OpenAI sends
 * `x-ratelimit-reset-<name>` as a duration. Each comes with a `remaining` header that is 0 for the limit that was hit.
 */
function resetAt(headers: Headers, now: number): string | undefined {
  const times: number[] = [];
  headers.forEach((value, name) => {
    const anthropic = /^anthropic-ratelimit-(.+)-reset$/.exec(name);
    if (anthropic && headers.get(`anthropic-ratelimit-${anthropic[1]}-remaining`) === "0") {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) times.push(t);
    }
    const openai = /^x-ratelimit-reset-(.+)$/.exec(name);
    if (openai && headers.get(`x-ratelimit-remaining-${openai[1]}`) === "0") {
      const d = parseDuration(value);
      if (d !== undefined) times.push(now + d);
    }
  });
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined;
}

/** The error message inside a JSON error body, or the body itself. */
function message(body: string): { text: string; json?: any } {
  try {
    const json = JSON.parse(body);
    const err = Array.isArray(json) ? json[0]?.error : json?.error;
    const text = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : body;
    return { text, json: Array.isArray(json) ? json[0] : json };
  } catch {
    return { text: body };
  }
}

/** Gemini puts the wait in `error.details[].retryDelay` on a `google.rpc.RetryInfo` entry. */
function retryDelay(json: any): number | undefined {
  const details: unknown[] = Array.isArray(json?.error?.details) ? json.error.details : [];
  for (const d of details as { "@type"?: string; retryDelay?: string }[]) {
    if (d?.["@type"]?.endsWith("google.rpc.RetryInfo") && typeof d.retryDelay === "string") return parseDuration(d.retryDelay);
  }
  return undefined;
}

/**
 * The limit an HTTP API reported in a 429 answer, or undefined for any other status. Pure: pass the response's
 * status, headers and body text, and the current time.
 */
export function parseHttpLimit(status: number, headers: Headers, body: string, now = Date.now()): LimitEvent | undefined {
  if (status !== 429) return undefined;
  const { text, json } = message(body);
  const wait = retryAfter(headers, now) ?? retryDelay(json);
  const code = String(json?.error?.code ?? json?.error?.type ?? "");
  // A used-up balance does not clear by waiting. A per-minute quota that names a wait does.
  const quota = code === "insufficient_quota" || (wait === undefined && /credit|billing|insufficient_quota/i.test(text));
  const limit: Limit = { kind: quota ? "quota" : "rate", detail: text.trim().slice(0, 500) || `HTTP ${status}` };
  if (wait !== undefined) limit.retryAfterMs = wait;
  const reset = resetAt(headers, now);
  if (reset) limit.resetAt = reset;
  return { type: "limit", ...limit };
}
