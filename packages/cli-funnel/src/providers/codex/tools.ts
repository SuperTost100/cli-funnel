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

const SERVER_HEADER = /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm;

/** MCP server names declared in a Codex config file. Only the table headers are read. */
function declaredServers(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return [...text.matchAll(SERVER_HEADER)].map((m) => m[1] ?? m[2]!);
}

/**
 * Enabled MCP servers declared in the user's or the project's Codex config. Servers that plugins and
 * features add are left out: switching the feature off removes them, and an `enabled` override for a
 * server that no config file defines makes Codex reject the whole configuration.
 */
async function configMcpServers(bin: string, cwd: string): Promise<string[]> {
  const res = await exec(bin, ["mcp", "list", "--json"], { timeoutMs: 20_000 });
  if (res.code !== 0) throw new Error(`codex mcp list failed: ${(res.stderr || res.stdout).trim().slice(0, 200)}`);
  const enabled = new Set(
    (JSON.parse(res.stdout) as { name: string; enabled?: boolean }[]).filter((s) => s.enabled !== false).map((s) => s.name),
  );
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const declared = [...declaredServers(join(home, "config.toml")), ...declaredServers(join(cwd, ".codex", "config.toml"))];
  return [...new Set(declared)].filter((name) => enabled.has(name));
}

/**
 * Per-thread config overrides for `none`, in the dotted form `codex -c` takes.
 * Measured: a one-line prompt drops from about 19,000 input tokens to about 11,900, and the model
 * reports no shell tool. Config MCP servers are switched off by name, since an empty table does not replace them.
 */
export async function noToolsConfig(bin: string, cwd: string): Promise<Record<string, unknown>> {
  const servers = await configMcpServers(bin, cwd);
  return Object.fromEntries([
    ...TOOL_FEATURES.map((f) => [`features.${f}`, false]),
    ["web_search", "disabled"],
    ["include_apply_patch_tool", false],
    ["tools.view_image", false],
    ...servers.map((name) => [`mcp_servers.${name}.enabled`, false]),
  ]);
}
