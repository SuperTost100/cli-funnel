import type { AuthStatus } from "../../types.js";

/** Parses `codex login status` text. It never echoes key material. */
export function parseLoginStatus(text: string): AuthStatus {
  const line = text.trim().split("\n")[0] ?? "";
  if (/not logged in/i.test(line)) return { loggedIn: false, detail: line };
  if (/logged in using chatgpt/i.test(line)) return { loggedIn: true, method: "ChatGPT", detail: line };
  if (/logged in using an api key/i.test(line)) return { loggedIn: true, method: "API key", detail: "Logged in using an API key" };
  const other = line.match(/logged in using (.+)/i);
  if (other) return { loggedIn: true, method: other[1]?.trim(), detail: line };
  return { loggedIn: false, detail: line || undefined };
}

/**
 * How the app-server signed in, from the `account/read` response: a ChatGPT account login or an API key. Only the
 * account type is read. The response can carry the account's email, which is never kept.
 */
export function authKind(res: unknown): "account" | "api-key" | undefined {
  const type = (res as { account?: { type?: unknown } | null } | null)?.account?.type;
  return type === "apiKey" ? "api-key" : type === "chatgpt" ? "account" : undefined;
}

/**
 * `AuthStatus` from the `account/read` response, for a ChatGPT account or an API key. The labels match `parseLoginStatus`.
 * `account` is the email and `plan` the plan type, as Claude Code reports them. Any other answer (no account, or a
 * Bedrock or GCP login) gives undefined, so the caller falls back to `codex login status`.
 */
export function accountStatus(res: unknown): AuthStatus | undefined {
  const account = (res as { account?: { type?: unknown; email?: unknown; planType?: unknown } | null } | null)?.account;
  if (account?.type === "apiKey") return { loggedIn: true, method: "API key", detail: "Logged in using an API key" };
  if (account?.type !== "chatgpt") return undefined;
  return {
    loggedIn: true,
    method: "ChatGPT",
    ...(typeof account.email === "string" && account.email ? { account: account.email } : {}),
    ...(typeof account.planType === "string" && account.planType ? { plan: account.planType } : {}),
    detail: "Logged in using ChatGPT",
  };
}
