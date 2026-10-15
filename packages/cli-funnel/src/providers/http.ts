import type { FunnelEvent } from "../types.js";

export interface RetryOptions {
  /** Extra attempts after a 429 or 5xx answer. Default 2, so a call is sent at most 3 times. 0 turns retries off. */
  retries?: number;
  /** First wait in milliseconds, doubled for each retry. Default 500. A `Retry-After` header wins over it. */
  retryDelayMs?: number;
}

/** A server that asks for a longer wait than this gets no retry. The error reaches the caller instead. */
export const MAX_RETRY_WAIT_MS = 30_000;

/** Reads `Retry-After` as delta-seconds or an HTTP date. Returns milliseconds, or undefined when absent or unreadable. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const retryable = (status: number) => status === 429 || (status >= 500 && status !== 501);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Sends a request and sends it again on 429 or 5xx, up to `retries` more times. It yields a `retry` event before
 * each wait and returns the final response, which may still be an error. Nothing is read from a response that
 * is sent again, and a response that is returned is untouched, so a caller that starts reading text never retries.
 * Network errors and aborts throw as `fetch` does.
 */
export async function* fetchRetrying(url: string, init: RequestInit, options: RetryOptions = {}): AsyncGenerator<FunnelEvent, Response> {
  const retries = Math.max(0, options.retries ?? 2);
  const base = options.retryDelayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok || !retryable(res.status) || attempt > retries) return res;
    const delayMs = retryAfterMs(res.headers.get("retry-after")) ?? base * 2 ** (attempt - 1);
    if (delayMs > MAX_RETRY_WAIT_MS) return res;
    await res.body?.cancel().catch(() => {});
    yield { type: "retry", attempt, status: res.status, delayMs };
    await sleep(delayMs, init.signal ?? undefined);
  }
}

/** Header names are case-insensitive. Lowercasing both sides lets `extra` replace a default instead of sitting beside it. */
export function mergeHeaders(base: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of [...Object.entries(base), ...Object.entries(extra)]) out[k.toLowerCase()] = v;
  return out;
}
