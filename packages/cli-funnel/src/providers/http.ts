import { FunnelError, type Capabilities, type FunnelEvent, type Provider } from "../types.js";
import { parseHttpLimit, retryAfter } from "./limits.js";

export interface RetryOptions {
  /** Extra attempts after a 429 or 5xx answer. Default 2, so a call is sent at most 3 times. 0 turns retries off. */
  retries?: number;
  /** First wait in milliseconds, doubled for each retry. Default 500. A `Retry-After` header wins over it. */
  retryDelayMs?: number;
}

/** A server that asks for a longer wait than this gets no retry. The error reaches the caller instead. */
const MAX_RETRY_WAIT_MS = 30_000;

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
    const delayMs = retryAfter(res.headers) ?? base * 2 ** (attempt - 1);
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

/** `Authorization: Bearer <key>`, or nothing when there is no key. */
export const bearer = (key?: string): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

/** Headers for a JSON request. `extra` replaces a default of the same name. */
export const jsonHeaders = (key?: string, extra?: Record<string, string>): Record<string, string> =>
  mergeHeaders({ ...bearer(key), "content-type": "application/json" }, extra);

/** How much of an error body goes into a message. A proxy page or a debug dump can be megabytes. */
const MAX_ERROR_BODY = 2000;

/** A failed response as events: a `limit` first when the API answered 429, then the error. */
export async function* httpError(label: string, res: Response): AsyncGenerator<FunnelEvent> {
  const body = await res.text();
  const limit = parseHttpLimit(res.status, res.headers, body);
  if (limit) yield limit;
  yield { type: "error", message: `${label} ${res.status}: ${body.slice(0, MAX_ERROR_BODY)}`, code: "cli-failed" };
}

/** The stream ended without the vendor's own end marker, so the answer may be cut off. */
export const truncated = (label: string): FunnelEvent => ({ type: "error", message: `${label} closed the stream before the answer finished.`, code: "stream-truncated" });

/** What every HTTP provider can do. A provider overrides the entries where it differs. */
export const httpCapabilities = (over: Partial<Capabilities> = {}): Capabilities => ({
  access: [],
  effort: true,
  contextWindow: false,
  fast: false,
  resume: true,
  approvals: false,
  images: true,
  messages: true,
  tools: true,
  system: "native",
  schema: "native",
  sampling: true,
  ...over,
});

/** The account members of a provider that has no sign-in: a key or a server URL is all it takes. */
export function httpAccount(messages: { login: string; logout: string; update: string }): Pick<Provider, "login" | "logout" | "update"> {
  return {
    login: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "error" as const, message: messages.login };
      },
      sendCode() {},
      cancel() {},
    }),
    logout: async () => {
      throw new FunnelError(messages.logout, "unsupported");
    },
    update: async () => ({ changed: false, output: messages.update }),
  };
}
