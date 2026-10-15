import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "../../util/process.js";

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
 * Enabled MCP servers declared in the user's or the project's Codex config. Servers that plugins and
 * features add are left out: switching the feature off removes them, and an `enabled` override for a
 * server that no config file defines makes Codex reject the whole configuration.
 * `env` is the run's environment, so a run pointed at another `CODEX_HOME` reads that home's servers.
 */
async function configMcpServers(bin: string, cwd: string, env?: Record<string, string>): Promise<string[]> {
  const res = await exec(bin, ["mcp", "list", "--json"], { cwd, env, timeoutMs: 20_000 });
  if (res.code !== 0) throw new Error(`codex mcp list failed: ${(res.stderr || res.stdout).trim().slice(0, 200)}`);
  const enabled = (JSON.parse(res.stdout) as { name: string; enabled?: boolean }[]).filter((s) => s.enabled !== false).map((s) => s.name);
  const home = env?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const text = readConfig(join(home, "config.toml")) + "\n" + readConfig(join(cwd, ".codex", "config.toml"));
  return declaredServers(text, enabled);
}

/**
 * Per-thread config overrides for `none`, in the dotted form `codex -c` takes.
 * Measured: a one-line prompt drops from about 19,000 input tokens to about 11,900, and the model
 * reports no shell tool. Config MCP servers are switched off by name, since an empty table does not replace them.
 */
export async function noToolsConfig(bin: string, cwd: string, env?: Record<string, string>): Promise<Record<string, unknown>> {
  const servers = await configMcpServers(bin, cwd, env);
  return Object.fromEntries([
    ...TOOL_FEATURES.map((f) => [`features.${f}`, false]),
    ["web_search", "disabled"],
    ["include_apply_patch_tool", false],
    ["tools.view_image", false],
    ...servers.map((name) => [`mcp_servers.${name}.enabled`, false]),
  ]);
}
