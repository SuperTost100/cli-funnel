import type { FunnelEvent, RunInput } from "../types.js";

const MASK = "[redacted]";

/**
 * Removes anything that could carry a credential from text that reaches an event: the configured keys, query strings
 * and credentials in URLs, `Bearer` values, and tokens shaped like `sk-...`, `AIza...`, `ghp_...` or `xoxb-...`.
 */
export function redact(text: string, secrets: (string | undefined)[] = []): string {
  // URLs go first, so a key that sits in a query string is cut with it instead of leaving a marker behind.
  let out = text
    .replace(/\bhttps?:\/\/[^\s"'<>)\]]+/g, (url) => url.replace(/^(https?:\/\/)[^/?#@]*@/, "$1").replace(/[?#].*$/, ""))
    // A server may echo only the request line, which is a path with a query. The path is bounded so a long run of
    // slashes cannot make the scan quadratic.
    .replace(/(\/[\w.~%/-]{0,256})\?[^\s"'<>]+/g, "$1");
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.replaceAll(s, MASK).replaceAll(encodeURIComponent(s), MASK);
  }
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `Bearer ${MASK}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, MASK)
    .replace(/\bAIza[0-9A-Za-z_-]{16,}/g, MASK)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{30,}/g, MASK)
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{20,}/g, MASK);
}

/**
 * Redacts the message of every `error` event and the detail of every `limit` event. Both can quote the server's answer.
 * An exception the stream throws is redacted the same way, since a parse error quotes the text it choked on.
 */
export async function* redactErrors(events: AsyncIterable<FunnelEvent>, secrets: (string | undefined)[]): AsyncGenerator<FunnelEvent> {
  try {
    for await (const e of events) {
      if (e.type === "error") yield { ...e, message: redact(e.message, secrets) };
      else if (e.type === "limit") yield { ...e, detail: redact(e.detail, secrets) };
      else yield e;
    }
  } catch (err) {
    throw transformError(err, (text) => redact(text, secrets));
  }
}

/** Header and env names whose values are credentials. */
const SECRET_NAME = /auth|token|key|secret|password|cookie|session|credential/i;

/**
 * The run's own secrets, longest first so a secret that contains another is masked whole: `apiKey` at any length, and
 * the values of `RunInput.env`, `mcpServers` headers and `mcpServers` env entries whose names look like credentials.
 * Those values are kept only from 8 characters, so masking them cannot mangle ordinary text. A multiline secret adds
 * each of its lines of 8 characters or more.
 */
export function runSecrets(input: Pick<RunInput, "apiKey" | "mcpServers" | "env">): string[] {
  const values: string[] = typeof input.apiKey === "string" && input.apiKey ? [input.apiKey] : [];
  // Runs before the request is validated, so a malformed entry is skipped rather than trusted.
  const named = (entries: unknown) => {
    if (typeof entries !== "object" || entries === null) return;
    for (const [name, value] of Object.entries(entries)) if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8) values.push(value);
  };
  named(input.env);
  const servers = typeof input.mcpServers === "object" && input.mcpServers !== null ? Object.values(input.mcpServers) : [];
  for (const server of servers) {
    if (typeof server !== "object" || server === null) continue;
    named(server.type === "http" ? server.headers : server.env);
  }
  // Output is masked line by line in places, such as stderr, so each line of a multiline secret (a PEM key) counts
  // on its own too, with the same floor so a short fragment cannot mangle ordinary text.
  const lines = values.flatMap((v) => (v.includes("\n") ? v.split(/\r?\n/).filter((l) => l.length >= 8) : []));
  return [...new Set([...values, ...lines])].sort((a, b) => b.length - a.length);
}

const maskText = (text: string, secrets: string[]) => secrets.reduce((s, secret) => s.replaceAll(secret, MASK), text);

/** `value` with `f` applied to every string and object key at any depth. Other values come back as they are. */
function mapStrings(value: unknown, f: (text: string) => string): unknown {
  if (typeof value === "string") return f(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, f));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [f(k), mapStrings(v, f)]));
  return value;
}

/** `value` with every secret masked, in strings and object keys at any depth. Other values come back as they are. */
export function mask(value: unknown, secrets: string[]): unknown {
  return mapStrings(value, (text) => maskText(text, secrets));
}

/**
 * `err` with `f` applied to its message, stack, cause and other own properties. The same object comes back,
 * so its class and `code` stay. A thrown value that is not an Error is treated like an event value.
 */
function transformError(err: unknown, f: (text: string) => string, depth = 0): unknown {
  if (!(err instanceof Error)) return mapStrings(err, f);
  if (depth > 3) return err;
  for (const key of Object.getOwnPropertyNames(err)) {
    const value = (err as unknown as Record<string, unknown>)[key];
    // `AggregateError.errors` holds Errors, whose message and stack are not enumerable, so they go through here too.
    const one = (v: unknown) => (v instanceof Error ? transformError(v, f, depth + 1) : mapStrings(v, f));
    const masked = Array.isArray(value) ? value.map(one) : one(value);
    if (masked !== value) Object.defineProperty(err, key, { value: masked, writable: true, configurable: true, enumerable: Object.prototype.propertyIsEnumerable.call(err, key) });
  }
  return err;
}

/** How many characters at the end of `text` could still be the start of a secret, so they have to wait for the next chunk. */
function pendingTail(text: string, secrets: string[]): number {
  let n = 0;
  for (const secret of secrets) {
    for (let k = Math.min(secret.length - 1, text.length); k > n; k--) {
      if (text.endsWith(secret.slice(0, k))) {
        n = k;
        break;
      }
    }
  }
  return n;
}

/**
 * Masks the run's secrets in every event, and in the message of an error the stream throws. An agent can print its own
 * environment, so an API key or a header value can show up in tool output, text or tool input. Only the exact values
 * are masked: the patterns `redact` adds would change ordinary URLs in the agent's output.
 *
 * A secret can arrive split across two `text.delta` events. Only the end of a chunk that could still become the start
 * of a secret is held back and joined to the next chunk. The rest goes out at once, and the held text is released
 * (masked) before any other event, at the end of the stream and before a thrown error.
 */
export async function* redactSecrets(events: AsyncIterable<FunnelEvent>, secrets: string[]): AsyncGenerator<FunnelEvent> {
  if (!secrets.length) return yield* events;
  let held = "";
  const release = function* (): Generator<FunnelEvent> {
    if (!held) return;
    const text = held;
    held = "";
    yield { type: "text.delta", text };
  };
  try {
    for await (const e of events) {
      if (e.type !== "text.delta") {
        yield* release();
        yield mask(e, secrets) as FunnelEvent;
        continue;
      }
      // Masking the joined text first means no whole secret is left in it, so the held tail is plain text.
      const text = maskText(held + e.text, secrets);
      const keep = pendingTail(text, secrets);
      held = text.slice(text.length - keep);
      const out = text.slice(0, text.length - keep);
      if (out) yield { ...e, text: out };
    }
    yield* release();
  } catch (err) {
    yield* release();
    throw transformError(err, (text) => maskText(text, secrets));
  }
}
