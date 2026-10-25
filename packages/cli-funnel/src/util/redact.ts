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

/** Redacts the message of every `error` event and the detail of every `limit` event. Both can quote the server's answer. */
export async function* redactErrors(events: AsyncIterable<FunnelEvent>, secrets: (string | undefined)[]): AsyncGenerator<FunnelEvent> {
  for await (const e of events) {
    if (e.type === "error") yield { ...e, message: redact(e.message, secrets) };
    else if (e.type === "limit") yield { ...e, detail: redact(e.detail, secrets) };
    else yield e;
  }
}

/** Header and env names whose values are credentials. */
const SECRET_NAME = /auth|token|key|secret|password|cookie|session|credential/i;

/**
 * The run's own secrets: `apiKey`, and the values of `mcpServers` headers and env entries whose names look like
 * credentials. Values shorter than 8 characters are left out, so masking them cannot mangle ordinary text.
 */
export function runSecrets(input: Pick<RunInput, "apiKey" | "mcpServers">): string[] {
  const values: unknown[] = [input.apiKey];
  // Runs before the request is validated, so a malformed entry is skipped rather than trusted.
  const servers = typeof input.mcpServers === "object" && input.mcpServers !== null ? Object.values(input.mcpServers) : [];
  for (const server of servers) {
    if (typeof server !== "object" || server === null) continue;
    const named: unknown = server.type === "http" ? server.headers : server.env;
    if (typeof named !== "object" || named === null) continue;
    for (const [name, value] of Object.entries(named)) if (SECRET_NAME.test(name) && typeof value === "string") values.push(value);
  }
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length >= 8))];
}

/** `value` with every secret masked, in strings at any depth. Other values come back as they are. */
function mask(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return secrets.reduce((s, secret) => s.replaceAll(secret, MASK), value);
  if (Array.isArray(value)) return value.map((v) => mask(v, secrets));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, secrets)]));
  return value;
}

/**
 * Masks the run's secrets in every event. An agent can print its own environment, so an API key or a header value can
 * show up in tool output, text or tool input. Only the exact values are masked: the patterns `redact` adds would
 * change ordinary URLs in the agent's output. shortcut: a secret split across two `text.delta` chunks is not caught;
 * buffer the stream if that ever matters.
 */
export async function* redactSecrets(events: AsyncIterable<FunnelEvent>, secrets: string[]): AsyncGenerator<FunnelEvent> {
  if (!secrets.length) return yield* events;
  for await (const e of events) yield mask(e, secrets) as FunnelEvent;
}
