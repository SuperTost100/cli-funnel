import type { FunnelEvent } from "../types.js";

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
