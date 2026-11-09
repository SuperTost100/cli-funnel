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
