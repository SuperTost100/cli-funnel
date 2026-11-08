import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Feature flags that add tools or side effects. `none` turns them off. Checked against
 * `codex features list` on 0.159. Unknown keys are ignored by Codex, so a renamed flag fails open:
 * the read-only sandbox and the deny-all approvals still hold.
 */
const TOOL_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "multi_agent",
  "multi_agent_v2",
  "browser_use",
  "computer_use",
  "image_generation",
  "hooks",
  "skill_search",
  "tool_suggest",
  "goals",
  "sleep_tool",
  "code_mode_host",
  "memories",
  "in_app_browser",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The names in `names` that a Codex config file declares as MCP servers. TOML can spell a server key bare,
 * double-quoted or single-quoted, in a `[mcp_servers.x]` header, a dotted `mcp_servers.x.command` key, or as a key
 * under `[mcp_servers]` or in an inline `mcp_servers = { x = {...} }` table. The match is loose on purpose: a false
 * positive makes Codex reject the override and the run fails, a false negative would let the server start.
 */
export function declaredServers(text: string, names: string[]): string[] {
  const hasTable = /^\s*(?:\[\s*mcp_servers\s*\]|mcp_servers\s*=\s*\{)/m.test(text);
  return names.filter((name) => {
    const key = `(?:${escape(name)}|"${escape(name)}"|'${escape(name)}')`;
    const dotted = new RegExp(`^\\s*\\[?\\s*mcp_servers\\s*\\.\\s*${key}\\s*[.=\\]]`, "m");
    const nested = new RegExp(`(?:^|[{,])\\s*${key}\\s*[.=]`, "m");
    return dotted.test(text) || (hasTable && nested.test(text));
  });
}

function readConfig(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * The MCP servers in the effective config, from the app-server's answer to `config/read` with the thread's `cwd`.
 * Codex parses every config layer itself, so every TOML spelling counts, and so do the system and project layers.
 * Servers that plugins and features add are not in it: switching the feature off removes them, and an `enabled`
 * override for a server that no config file defines makes Codex reject the whole configuration. Throws when the
 * answer has no `mcp_servers` table, so a `none` thread never starts with a server it could not see.
 */
export function configServers(res: unknown): string[] {
  const servers = (res as { config?: { mcp_servers?: unknown } } | null)?.config?.mcp_servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("config/read returned no mcp_servers table.");
  return Object.keys(servers);
}

/**
 * The names in `names` that the user's or the project's `config.toml` declares as MCP servers, read from the files
 * without starting Codex. Thread config keys merge into a server of the same name, so a caller's server must not
 * reuse one of these names.
 */
export function configDeclares(names: string[], cwd: string, env?: Record<string, string>): string[] {
  if (!names.length) return [];
  const home = env?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const text = readConfig(join(home, "config.toml")) + "\n" + readConfig(join(cwd, ".codex", "config.toml"));
  return declaredServers(text, names);
}

/**
 * Per-thread config overrides for `none`, in the dotted form `codex -c` takes.
 * Measured: a one-line prompt drops from about 19,000 input tokens to about 11,900, and the model
 * reports no shell tool. `servers` are the config's MCP servers, from `configServers`. They are switched off by name,
 * since an empty table does not replace them. The names go in a nested table, because a dotted key cannot spell a
 * name with a dot: `mcp_servers.a.b.enabled` is server `a`. Codex merges the table into the config, checked on 0.166.
 */
export function noToolsConfig(servers: string[]): Record<string, unknown> {
  return Object.fromEntries([
    ...TOOL_FEATURES.map((f) => [`features.${f}`, false]),
    ["web_search", "disabled"],
    ["include_apply_patch_tool", false],
    ["tools.view_image", false],
    ...(servers.length ? [["mcp_servers", Object.fromEntries(servers.map((name) => [name, { enabled: false }]))]] : []),
  ]);
}
