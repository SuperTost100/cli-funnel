import type { FunnelEvent, ProviderId } from "../types.js";

/** An MCP tool call of the run, as each CLI names it. See `FunnelEvent` `tool.start`. */
export interface McpCall {
  server: string;
  tool: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What agy puts in front of the name of a server that the print transport's plugin carries. See `MCP_PLUGIN` in `providers/antigravity`. */
const PRINT_PLUGIN = "funnel_";

/** Cursor Agent's name for the servers of a `--plugin-dir` plugin, `plugin-<folder>-<server>`. See `providers/agent/mcp.ts`. */
const CURSOR_PLUGIN_PREFIX = "plugin-funnel-";

/**
 * Tells whether a CLI tool call is a call to a tool of one of the caller's `mcpServers`, and which. Each CLI names it
 * differently: `mcp__<server>__<tool>` on Claude Code, `mcp:<server>/<tool>` on Codex, `mcp_<server>_<tool>` or
 * `call_mcp_tool` with `ServerName` and `ToolName` on Antigravity, and an `mcp` call whose input names the plugin server
 * and the tool on Cursor Agent. Only the caller's own servers match, so a call to a server of the user's config is not
 * reported as one. A server name is tried whole, longest first, so `a` never claims a tool of `a_b`.
 */
export function mcpCall(name: string, input: unknown, servers: readonly string[], provider?: ProviderId): McpCall | undefined {
  const byLength = [...servers].sort((a, b) => b.length - a.length);
  for (const server of byLength) {
    for (const prefix of [`mcp__${server}__`, `mcp_${server}_`]) {
      if (name.startsWith(prefix) && name.length > prefix.length) return { server, tool: name.slice(prefix.length) };
    }
    const codex = `mcp:${server}/`;
    if (name.startsWith(codex) && name.length > codex.length) return { server, tool: name.slice(codex.length) };
  }
  if (!isObj(input)) return undefined;
  if (name === "call_mcp_tool" && typeof input.ServerName === "string" && typeof input.ToolName === "string") {
    // On Antigravity's print transport the servers are one plugin, `funnel`, and agy calls each by `funnel_<name>`.
    const server = provider === "antigravity" && input.ServerName.startsWith(PRINT_PLUGIN) ? input.ServerName.slice(PRINT_PLUGIN.length) : input.ServerName;
    if (servers.includes(server)) return { server, tool: input.ToolName };
  }
  const id = input.serverIdentifier;
  if (name === "mcp" && typeof id === "string" && typeof input.toolName === "string" && id.startsWith(CURSOR_PLUGIN_PREFIX)) {
    const server = id.slice(CURSOR_PLUGIN_PREFIX.length);
    if (servers.includes(server)) return { server, tool: input.toolName };
  }
  return undefined;
}

/** Adds `mcp` to the `tool.start` event of each call to one of `servers`. Other events pass unchanged. */
export async function* tagMcpCalls(events: AsyncIterable<FunnelEvent>, servers: readonly string[], provider?: ProviderId): AsyncGenerator<FunnelEvent> {
  for await (const e of events) {
    if (e.type === "tool.start" && !e.parentId) {
      const call = e.mcp ?? mcpCall(e.name, e.input, servers, provider);
      if (call) {
        yield e.mcp ? e : { ...e, mcp: call };
        continue;
      }
    }
    yield e;
  }
}
