import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accessFlags, nonePermissionsWithMcp, NONE_PERMISSIONS, parseMcpList, noneWorkspace as agentNone } from "../src/providers/agent/index.js";
import { acpMcpServers, decidePermission } from "../src/providers/antigravity/acp/protocol.js";
import { exceptNames, NONE_MATCHER, noneHooks, noneWorkspace as agyNone } from "../src/providers/antigravity/index.js";
import { buildArgs as claudeArgs } from "../src/providers/claude/index.js";
import { agentConfig, noneServers } from "../src/providers/codex/options.js";
import { noToolsConfig } from "../src/providers/codex/tools.js";
import { mcpCall, tagMcpCalls } from "../src/providers/mcp-calls.js";
import { mcpServersFor } from "../src/providers/options.js";
import { createRunFolder } from "../src/providers/base.js";
import { FunnelError, type FunnelEvent, type RunInput } from "../src/types.js";

const servers: RunInput["mcpServers"] = {
  notes: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer secret-token" } },
  local: { type: "stdio", command: "node", args: ["s.js"], env: { A: "b" } },
};
const run = (provider: "claude" | "codex" | "agent" | "antigravity", over: Partial<RunInput> = {}): RunInput => ({
  selection: { provider, model: "m", cwd: tmpdir(), access: "none" },
  prompt: "x",
  mcpServers: servers,
  ...over,
});
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof FunnelError ? e.code : "other";
  }
};

describe("MCP servers at access none", () => {
  it("are refused unless the provider lists the kind for none", () => {
    expect(code(() => mcpServersFor(run("claude"), ["http", "stdio"]))).toBe("invalid-selection");
    expect(code(() => mcpServersFor(run("claude"), ["http", "stdio"], undefined, ["http", "stdio"]))).toBe("ok");
    expect(code(() => mcpServersFor(run("claude", { mcpServers: { s: servers!.local! } }), ["http", "stdio"], undefined, ["http"]))).toBe("invalid-selection");
  });

  it("keep their other rules: a bad name, a bad URL and an unknown key still fail", () => {
    const at = (s: unknown) => code(() => mcpServersFor(run("claude", { mcpServers: s as never }), ["http", "stdio"], undefined, ["http", "stdio"]));
    expect(at({ "bad name": servers!.notes })).toBe("invalid-selection");
    expect(at({ a: { type: "http", url: "ftp://x" } })).toBe("invalid-selection");
    expect(at({ a: { type: "http", url: "http://x", extra: 1 } })).toBe("invalid-selection");
  });
});

describe("Claude Code at none with servers", () => {
  const args = claudeArgs(run("claude"), undefined, false, "/tmp/mcp.json");
  it("keeps every built-in tool and the user's servers off and allows the caller's servers by name", () => {
    expect(args).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--setting-sources", ""]));
    expect(args).toContain("--mcp-config=/tmp/mcp.json");
    expect(args).toContain("--allowed-tools=mcp__notes");
    expect(args).toContain("--allowed-tools=mcp__local");
    expect(args).not.toContain("--permission-prompt-tool");
  });
  it("allows nothing without servers", () => {
    expect(claudeArgs(run("claude", { mcpServers: undefined }))).not.toContain("--allowed-tools=mcp__notes");
  });
});

describe("Codex at none with servers", () => {
  it("puts the servers in the table that also switches the user's servers off, each approved and required", () => {
    const callers = noneServers(run("codex"));
    expect(callers.notes).toEqual({ url: "http://127.0.0.1:9/mcp", http_headers: { Authorization: "Bearer secret-token" }, default_tools_approval_mode: "approve", required: true });
    expect(callers.local).toEqual({ command: "node", args: ["s.js"], env: { A: "b" }, default_tools_approval_mode: "approve", required: true });
    const config = noToolsConfig(["theirs"], callers);
    expect(config.mcp_servers).toEqual({ theirs: { enabled: false }, ...callers });
    expect(config["features.shell_tool"]).toBe(false);
  });

  it("does not repeat them as dotted keys, which would clash with that table", () => {
    expect(Object.keys(agentConfig(run("codex"))).filter((k) => k.startsWith("mcp_servers"))).toEqual([]);
    expect(Object.keys(agentConfig(run("codex", { selection: { provider: "codex", model: "m", cwd: tmpdir(), access: "full" } }))).filter((k) => k.startsWith("mcp_servers.notes"))).not.toEqual([]);
  });
});

describe("Antigravity at none with servers", () => {
  const matches = (re: string, s: string) => new RegExp(re).test(s);

  it("builds a pattern that matches every tool name except the ones left alone", () => {
    const re = exceptNames(["finish", "call_mcp_tool"], ["mcp_notes_", "mcp_local_"]);
    for (const left of ["finish", "call_mcp_tool", "mcp_notes_add_note", "mcp_local_x", "mcp_notes_"]) expect(matches(re, left), left).toBe(false);
    for (const hit of ["", "f", "finis", "finishx", "call_mcp", "call_mcp_tools", "run_command", "read_file", "mcp_other_add_note", "mcp_notes", "mcp_note", "mcp", "xcall_mcp_tool", "invoke_subagent"]) expect(matches(re, hit), hit).toBe(true);
  });

  it("agrees with the pattern the print transport already used for finish", () => {
    const re = exceptNames(["finish"]);
    for (const s of ["finish", "", "f", "fini", "finish ", "finishes", "write_file", "run_command", "Finish"]) expect(matches(re, s), s).toBe(matches(NONE_MATCHER, s));
  });

  it("writes the hook with that pattern, and its own folder for each set of servers", async () => {
    const hooks = noneHooks("linux", { names: ["finish", "call_mcp_tool"], prefixes: ["mcp_notes_"] }) as any;
    expect(matches(hooks["cli-funnel-none"].PreToolUse[0].matcher, "mcp_notes_add_note")).toBe(false);
    expect(matches(hooks["cli-funnel-none"].PreToolUse[0].matcher, "run_command")).toBe(true);
    process.env.XDG_CACHE_HOME = join(tmpdir(), "cf-mcp-none-cache");
    const plain = await agyNone();
    const a = await agyNone(undefined, ["notes"]);
    expect(await agyNone(undefined, ["notes"])).toBe(a);
    expect(await agyNone(undefined, ["other"])).not.toBe(a);
    expect(a).not.toBe(plain);
    expect(JSON.parse(readFileSync(join(plain, ".agents", "hooks.json"), "utf8"))["cli-funnel-none"].PreToolUse[0].matcher).toBe(NONE_MATCHER);
    delete process.env.XDG_CACHE_HOME;
  });

  it("hands the servers to the session in ACP's shape", () => {
    expect(acpMcpServers(Object.entries(servers!))).toEqual([
      { type: "http", name: "notes", url: "http://127.0.0.1:9/mcp", headers: [{ name: "Authorization", value: "Bearer secret-token" }] },
      { name: "local", command: "node", args: ["s.js"], env: [{ name: "A", value: "b" }] },
    ]);
  });

  it("allows a permission request for the caller's server only", () => {
    const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
    const ask = (toolCall: unknown) => decidePermission({ toolCall, options }, new Set(["notes"]));
    const allow = { outcome: { outcome: "selected", optionId: "allow" } };
    const deny = { outcome: { outcome: "selected", optionId: "deny" } };
    expect(ask({ name: "mcp_notes_add_note", rawInput: { text: "x" } })).toEqual(allow);
    expect(ask({ name: "call_mcp_tool", rawInput: { ServerName: "notes", ToolName: "add_note" } })).toEqual(allow);
    expect(ask({ name: "call_mcp_tool", rawInput: { ServerName: "theirs", ToolName: "x" } })).toEqual(deny);
    expect(ask({ name: "mcp_theirs_x" })).toEqual(deny);
    expect(ask({ name: "run_command", rawInput: { CommandLine: "touch x" } })).toEqual(deny);
  });
});

describe("Cursor Agent at none with servers", () => {
  it("drops the blanket MCP deny, denies the user's servers by name and allows the plugin's", () => {
    const p = nonePermissionsWithMcp(["Mcp(plugin-funnel-notes:*)"], ["playwright", "figma"]);
    expect(p.permissions.allow).toEqual(["Mcp(plugin-funnel-notes:*)"]);
    expect(p.permissions.deny).toEqual(expect.arrayContaining(["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)", "Mcp(playwright:*)", "Mcp(figma:*)"]));
    expect(p.permissions.deny).not.toContain("Mcp(*:*)");
    expect(NONE_PERMISSIONS.permissions.deny).toContain("Mcp(*:*)");
  });

  it("reads the names from agent mcp list", () => {
    expect(parseMcpList("playwright: ready\nfigma: requires_authentication\n\ncloudflare-api: ready\n")).toEqual(["playwright", "figma", "cloudflare-api"]);
    expect(parseMcpList("No MCP servers configured\n")).toEqual([]);
  });

  it("drops ask mode only for a run with servers, which ask mode blocks", () => {
    expect(accessFlags("none")).toEqual(["--mode", "ask"]);
    expect(accessFlags("none", true)).toEqual([]);
  });

  it("keeps a folder per rule set", async () => {
    process.env.XDG_CACHE_HOME = join(tmpdir(), "cf-mcp-none-cache");
    const a = await agentNone(undefined, { allow: ["Mcp(plugin-funnel-notes:*)"], userServers: ["x"] });
    expect(await agentNone(undefined, { allow: ["Mcp(plugin-funnel-notes:*)"], userServers: ["x"] })).toBe(a);
    expect(await agentNone(undefined, { allow: ["Mcp(plugin-funnel-notes:*)"], userServers: ["y"] })).not.toBe(a);
    expect(a).not.toBe(await agentNone());
    delete process.env.XDG_CACHE_HOME;
  });
});

describe("MCP calls in the event stream", () => {
  const names = ["notes", "notes_two", "local"];
  it("recognises the call each CLI reports", () => {
    expect(mcpCall("mcp__notes__add_note", {}, names)).toEqual({ server: "notes", tool: "add_note" });
    expect(mcpCall("mcp:notes/add_note", {}, names)).toEqual({ server: "notes", tool: "add_note" });
    expect(mcpCall("mcp_notes_add_note", {}, names)).toEqual({ server: "notes", tool: "add_note" });
    expect(mcpCall("call_mcp_tool", { ServerName: "local", ToolName: "t", Arguments: {} }, names)).toEqual({ server: "local", tool: "t" });
    expect(mcpCall("mcp", { serverIdentifier: "plugin-funnel-notes", toolName: "add_note" }, names)).toEqual({ server: "notes", tool: "add_note" });
  });

  it("takes the longest server name, so a short one never claims another's tool", () => {
    expect(mcpCall("mcp_notes_two_add", {}, names)).toEqual({ server: "notes_two", tool: "add" });
  });

  it("leaves calls to anything else alone", () => {
    expect(mcpCall("run_command", { CommandLine: "ls" }, names)).toBeUndefined();
    expect(mcpCall("mcp__theirs__x", {}, names)).toBeUndefined();
    expect(mcpCall("call_mcp_tool", { ServerName: "theirs", ToolName: "x" }, names)).toBeUndefined();
    expect(mcpCall("mcp", { serverIdentifier: "playwright", toolName: "x" }, names)).toBeUndefined();
    expect(mcpCall("mcp__notes__", {}, names)).toBeUndefined();
  });

  it("tags the tool.start event and the run's tool call, and not a subagent's", async () => {
    const events: FunnelEvent[] = [
      { type: "tool.start", id: "1", name: "mcp__notes__add_note", input: { text: "x" } },
      { type: "tool.end", id: "1", output: "Note saved." },
      { type: "tool.start", id: "2", name: "Bash", input: {} },
      { type: "tool.start", id: "3", name: "mcp__notes__add_note", parentId: "9" },
      { type: "done", text: "ok", finishReason: "stop" },
    ];
    const tagged: FunnelEvent[] = [];
    for await (const e of tagMcpCalls((async function* () { yield* events; })(), names)) tagged.push(e);
    expect(tagged[0]).toMatchObject({ type: "tool.start", mcp: { server: "notes", tool: "add_note" } });
    expect(tagged[2]).not.toHaveProperty("mcp");
    expect(tagged[3]).not.toHaveProperty("mcp");
    const folder = createRunFolder(run("claude"));
    for (const e of tagged) folder.add(e);
    expect(folder.finish().toolCalls).toEqual([
      { id: "1", name: "mcp__notes__add_note", input: { text: "x" }, mcp: { server: "notes", tool: "add_note" } },
      { id: "2", name: "Bash", input: {} },
    ]);
  });
});
