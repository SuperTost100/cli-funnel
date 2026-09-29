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
