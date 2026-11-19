import { createHash } from "node:crypto";
import { FunnelError, type McpServer } from "../../types.js";
import { ownedWorkspace } from "../../util/workspace.js";

const ENV_PREFIX = "CLI_FUNNEL_MCP_";

/** The plugin folder name. It becomes part of the tool names the model sees: `plugin-funnel-<server>-<tool>`. */
const PLUGIN_NAME = "funnel";

export interface McpPlugin {
  /** The plugin's `.mcp.json`. Every value is a `${env:NAME}` reference, so the file holds no secret and no URL. */
  config: { mcpServers: Record<string, Record<string, unknown>> };
  /** The values the references point at. They go to the CLI process as environment variables. */
  env: Record<string, string>;
}

/**
 * Turns validated servers into a Cursor plugin config. The CLI expands `${env:NAME}` in the plugin's MCP config, so
 * URLs, header values, commands, arguments and server environment travel in the process environment. That keeps
 * tokens out of files and argv, and lets one config file serve every run with the same server names and header names.
 */
export function mcpPlugin(servers: [string, McpServer][]): McpPlugin {
  const env: Record<string, string> = {};
  const ref = (name: string, value: string) => {
    env[name] = value;
    return `\${env:${name}}`;
  };
  const mcpServers: McpPlugin["config"]["mcpServers"] = {};
  servers.forEach(([name, server], i) => {
    const key = `${ENV_PREFIX}${i}`;
    if (server.toolTimeoutSec !== undefined) {
      throw new FunnelError(`Cursor Agent cannot set a tool timeout for MCP server "${name}". Its MCP config has no such field.`, "unsupported");
    }
    if (server.type === "http") {
      mcpServers[name] = {
        url: ref(`${key}_URL`, server.url),
        ...(server.headers && Object.keys(server.headers).length
          ? { headers: Object.fromEntries(Object.entries(server.headers).map(([h, v], j) => [h, ref(`${key}_H${j}`, v)])) }
          : {}),
      };
    } else {
      mcpServers[name] = {
        command: ref(`${key}_CMD`, server.command),
        ...(server.args?.length ? { args: server.args.map((a, j) => ref(`${key}_A${j}`, a)) } : {}),
        ...(server.env && Object.keys(server.env).length
          ? { env: Object.fromEntries(Object.entries(server.env).map(([k, v], j) => [k, ref(`${key}_E${j}`, v)])) }
          : {}),
      };
    }
  });
  return { config: { mcpServers }, env };
}

/**
 * Writes the plugin folder for `--plugin-dir` and returns it with the environment it needs. The folder lives under
 * cli-funnel's cache and is named by the hash of its config, so runs with the same shape share it and nothing is
 * written to the project or to `~/.cursor`.
 */
export async function attachMcp(servers: [string, McpServer][]): Promise<{ dir: string; env: Record<string, string> }> {
  const { config, env } = mcpPlugin(servers);
  const mcpJson = `${JSON.stringify(config, null, 2)}\n`;
  const hash = createHash("sha256").update(mcpJson).digest("hex").slice(0, 16);
  const dir = await ownedWorkspace(`agent-mcp/${hash}/${PLUGIN_NAME}`, {
    ".cursor-plugin/plugin.json": `${JSON.stringify({ name: PLUGIN_NAME, description: "MCP servers for one cli-funnel run", version: "0.0.0" }, null, 2)}\n`,
    ".mcp.json": mcpJson,
  });
  return { dir, env };
}
