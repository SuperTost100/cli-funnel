import { FunnelError, type Capabilities, type FunnelEvent, type Provider, type RunInput } from "../types.js";
import { mask, runSecrets } from "../util/redact.js";
import { parseHttpLimit, retryAfter } from "./limits.js";

/** Request headers whose values are never secrets. Every other value of 8 characters or more is masked in `raw` data. */
const PLAIN_REQUEST_HEADERS = new Set(["content-type", "accept", "user-agent", "anthropic-version", "anthropic-beta", "openai-beta"]);

/**
 * Response headers left out of `raw` data, since they can carry a session or a credential. Token headers are matched
 * by kind (`x-session-token`, `refresh_token`), so token counts such as `x-ratelimit-remaining-tokens` stay.
 */
const HIDDEN_RESPONSE_HEADER =
  /cookie|authori[sz]ation|authenticate|secret|password|credential|api-key|(?:access|refresh|id|session|auth|bearer)[-_]?token(?:$|[-_])/i;

/** The `raw` events of a verbose HTTP run. Build it with `httpTap`. */
export interface HttpTap {
  /** The status and headers of a response, with credential headers left out. */
  response(res: Response): FunnelEvent;
  /** One SSE `data` field: the parsed JSON, or the string when it is not JSON, such as `[DONE]`. */
  sse(data: string): FunnelEvent;
  /** One NDJSON line as `readNDJSON` yields it. A line that was not JSON is sent as the string. */
  json(line: unknown): FunnelEvent;
}

/**
 * A tap for a verbose run, or undefined without `verbose`, so a normal run pays nothing. `key` and the values of
 * `headers` (the request's headers) are masked in everything it emits, together with the run's own secrets. Only
 * headers known to hold no secret, such as `content-type`, are left alone.
 */
// shortcut: each chunk is masked on its own, so a secret a server splits across two SSE events is not caught. The
// key and headers never reach the model, so only a server that echoes them in pieces could do that. Buffer the
// chunks if one ever does.
export function httpTap(input: RunInput, headers: Record<string, string> = {}, key?: string): HttpTap | undefined {
  if (!input.verbose) return undefined;
  // A Bearer header also yields its bare token, which is what a server would echo.
  const fromHeaders = Object.entries(headers).flatMap(([name, value]) =>
    !PLAIN_REQUEST_HEADERS.has(name.toLowerCase()) && value.length >= 8 ? [value, value.replace(/^Bearer\s+/i, "")] : [],
  );
  const secrets = [...new Set([...(key ? [key] : []), ...fromHeaders, ...runSecrets(input)])].sort((a, b) => b.length - a.length);
  const provider = input.selection.provider;
  const raw = (source: "response" | "http", data: unknown): FunnelEvent => ({ type: "raw", provider, source, data: mask(data, secrets) });
  return {
    response: (res) => {
      const shown: Record<string, string> = {};
      res.headers.forEach((value, name) => {
        if (!HIDDEN_RESPONSE_HEADER.test(name)) shown[name] = value;
      });
      return raw("response", { status: res.status, headers: shown });
    },
    sse: (data) => {
      try {
        return raw("http", JSON.parse(data));
      } catch {
        return raw("http", data);
      }
    },
    json: (line) =>
      raw("http", typeof line === "object" && line !== null && Object.keys(line).length === 1 && "__raw" in line ? String((line as { __raw: unknown }).__raw) : line),
  };
}

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
 * Network errors and aborts throw as `fetch` does. With a `tap`, each response's status and headers go out as `raw`.
 * Redirects are never followed, because a configured server could use one to send the request, with its body, to an
 * address of its choosing. A 3xx answer comes back as it is, and `httpError` reports it.
 */
export async function* fetchRetrying(url: string, init: RequestInit, options: RetryOptions = {}, tap?: HttpTap): AsyncGenerator<FunnelEvent, Response> {
  init = { ...init, redirect: "manual" };
  const retries = Math.max(0, options.retries ?? 2);
  const base = options.retryDelayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (tap) yield tap.response(res);
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

/** The error for a redirect answer. It names the status and leaves out the `Location`, which the server chose. */
export const redirectMessage = (label: string, status: number): string =>
  `${label} answered ${status}, a redirect. Redirects are not followed. Set the base URL to the final address.`;

/** A failed response as events: a `limit` first when the API answered 429, then the error. */
export async function* httpError(label: string, res: Response): AsyncGenerator<FunnelEvent> {
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    return yield { type: "error", message: redirectMessage(label, res.status), code: "cli-failed" };
  }
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
