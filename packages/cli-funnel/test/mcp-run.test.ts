import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accessFlags, agentProvider, NONE_PERMISSIONS, noneWorkspace as agentNone } from "../src/providers/agent/index.js";
import { createFunnel } from "../src/funnel.js";
import { checkAcpServers, createAcpMapper, decidePermission, reserveServers } from "../src/providers/antigravity/acp/protocol.js";
import { mcpHookScript, NONE_MATCHER, noneHooks, noneWorkspace as agyNone } from "../src/providers/antigravity/index.js";
import { buildArgs as claudeArgs } from "../src/providers/claude/index.js";
import { agentConfig, noneServers } from "../src/providers/codex/options.js";
import { noToolsConfig } from "../src/providers/codex/tools.js";
import { mcpCall, tagMcpCalls } from "../src/providers/mcp-calls.js";
import { createNoneGuard } from "../src/providers/none-guard.js";
import { mcpServersFor } from "../src/providers/options.js";
import { createRunFolder } from "../src/providers/base.js";
import { FunnelError, type FunnelEvent, type McpServer, type RunInput } from "../src/types.js";

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
  const hookCommand = (reserved: string[]) => {
    const hooks = noneHooks("linux", { reserved, script: "/cache/ws/.agents/mcp-hook.mjs" }) as any;
    return hooks["cli-funnel-none"].PreToolUse[0];
  };

  it("sends each server to agy under a reserved name and maps it back", () => {
    const r = reserveServers(Object.entries(servers!));
    expect(r.reserved).toEqual(["clifunnel0", "clifunnel1"]);
    expect(r.callers.get("clifunnel1")).toBe("local");
    expect(r.acp).toEqual([
      { type: "http", name: "clifunnel0", url: "http://127.0.0.1:9/mcp", headers: [{ name: "Authorization", value: "Bearer secret-token" }] },
      { name: "clifunnel1", command: "node", args: ["s.js"], env: [{ name: "A", value: "b" }] },
    ]);
  });

  it("refuses a caller name that has the reserved form, and a tool timeout ACP has no field for", () => {
    const at = (s: object) => code(() => checkAcpServers(Object.entries(s) as [string, McpServer][]));
    expect(at({ clifunnel0: servers!.notes })).toBe("invalid-selection");
    expect(at({ clifunnel12: servers!.notes })).toBe("invalid-selection");
    expect(at({ clifunnel: servers!.notes, Clifunnel0x: servers!.notes, notes: servers!.notes })).toBe("ok");
    expect(at({ notes: { ...servers!.notes, toolTimeoutSec: 30 } })).toBe("unsupported");
  });

  describe("the hook script", () => {
    const run = (stdin: string, reserved = ["clifunnel0", "clifunnel1"]) => {
      const res = spawnSync(process.execPath, ["-e", mcpHookScript(reserved)], { input: stdin, encoding: "utf8" });
      return { code: res.status, decision: res.stdout.trim() ? JSON.parse(res.stdout.trim()).decision : "none" };
    };
    const call = (name: string, args: object = {}) => JSON.stringify({ hookEventName: "PreToolUse", toolCall: { id: "c", name, args } });

    it("lets finish and this run's servers through, with no decision of its own", () => {
      expect(run(call("finish"))).toEqual({ code: 0, decision: "none" });
      expect(run(call("call_mcp_tool", { ServerName: "clifunnel1", ToolName: "t", Arguments: {} }))).toEqual({ code: 0, decision: "none" });
      expect(run(call("mcp_clifunnel0_add_note", { text: "x" }))).toEqual({ code: 0, decision: "none" });
    });

    it("denies every other tool, other servers by either route, and look-alike names", () => {
      for (const [name, args] of [
        ["run_command", { CommandLine: "ls" }],
        ["read_file", { Path: "/etc/hostname" }],
        ["call_mcp_tool", { ServerName: "theirs", ToolName: "t" }],
        ["call_mcp_tool", { ServerName: "clifunnel2", ToolName: "t" }],
        ["call_mcp_tool", { ServerName: "clifunnel", ToolName: "t" }],
        ["call_mcp_tool", { ServerName: "clifunnel0_x", ToolName: "t" }],
        ["call_mcp_tool", {}],
        ["mcp_theirs_add_note", {}],
        ["mcp_clifunnel2_add_note", {}],
        ["mcp_clifunnel0", {}],
        ["mcp_clifunnel0_", {}],
        ["Finish", {}],
        ["finish2", {}],
        ["", {}],
      ] as [string, object][]) {
        expect(run(call(name, args)).decision, `${name} ${JSON.stringify(args)}`).toBe("deny");
      }
    });

    it("denies what it cannot read, since a hook that errors must block", () => {
      for (const bad of ["", "not json", "{}", "[]", "null", JSON.stringify({ toolCall: null }), JSON.stringify({ toolCall: { name: 5 } })]) {
        expect(run(bad).decision, bad).toBe("deny");
      }
    });

    it("is a hook command that runs the Node binary of this process on a script file, with a matcher that matches every tool", () => {
      const h = hookCommand(["clifunnel0"]);
      expect(new RegExp(h.matcher).test("run_command")).toBe(true);
      expect(new RegExp(h.matcher).test("mcp_clifunnel0_x")).toBe(true);
      expect(h.hooks[0].command).toContain(process.execPath);
      expect(h.hooks[0].command).toContain("'/cache/ws/.agents/mcp-hook.mjs'");
    });
  });

  it("keeps the static hook when a run has no servers", async () => {
    const hooks = noneHooks("linux") as any;
    expect(hooks["cli-funnel-none"].PreToolUse[0].matcher).toBe(NONE_MATCHER);
    expect(hooks["cli-funnel-none"].PreToolUse[0].hooks[0].command).toContain("printf");
  });

  it("writes the script and the hook into a folder of its own, one per number of servers", async () => {
    process.env.XDG_CACHE_HOME = join(tmpdir(), "cf-mcp-none-cache");
    try {
      const plain = await agyNone();
      const a = await agyNone(undefined, 2);
      expect(await agyNone(undefined, 2)).toBe(a);
      expect(await agyNone(undefined, 1)).not.toBe(a);
      expect(readdirSync(join(a, ".agents")).sort()).toEqual(["hooks.json", "mcp-hook.mjs"]);
      expect(readFileSync(join(a, ".agents", "mcp-hook.mjs"), "utf8")).toContain('"clifunnel1"');
      expect(JSON.parse(readFileSync(join(plain, ".agents", "hooks.json"), "utf8"))["cli-funnel-none"].PreToolUse[0].matcher).toBe(NONE_MATCHER);
      // No name a caller can choose gives one run the folder of another.
      const folders = [await agyNone(), await agyNone("mcp"), await agyNone("x"), await agyNone("x", 1), await agyNone("x-mcp-1"), await agyNone("mcp", 1), await agyNone(undefined, 1)];
      expect(new Set(folders).size).toBe(folders.length);
    } finally {
      delete process.env.XDG_CACHE_HOME;
    }
  });

  it("allows a permission request for this run's reserved servers only, by exact name", () => {
    const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
    const reserved = new Set(["clifunnel0"]);
    const ask = (toolCall: unknown) => decidePermission({ toolCall, options }, reserved);
    const allow = { outcome: { outcome: "selected", optionId: "allow" } };
    const deny = { outcome: { outcome: "selected", optionId: "deny" } };
    expect(ask({ name: "mcp_clifunnel0_add_note", rawInput: { text: "x" } })).toEqual(allow);
    expect(ask({ name: "call_mcp_tool", rawInput: { ServerName: "clifunnel0", ToolName: "add_note" } })).toEqual(allow);
    expect(ask({ name: "call_mcp_tool", rawInput: { ServerName: "notes", ToolName: "x" } })).toEqual(deny);
    expect(ask({ name: "mcp_notes_x" })).toEqual(deny);
    expect(ask({ name: "mcp_clifunnel0" })).toEqual(deny);
    expect(ask({ name: "mcp_clifunnel1_x" })).toEqual(deny);
    expect(ask({ name: "run_command", rawInput: { CommandLine: "touch x" } })).toEqual(deny);
  });

  it("shows the caller's own name and tags the call, and lets only those calls finish at none", () => {
    const callers = new Map([["clifunnel0", "notes"]]);
    const mapper = createAcpMapper("S", { access: "none", mcp: callers });
    const guard = createNoneGuard((s) => s.name !== "finish" && !s.mcp);
    const feed = (u: object): (FunnelEvent | "stopped")[] => mapper.update(u).flatMap((e): (FunnelEvent | "stopped")[] => (guard.check(e) ? ["stopped"] : [e]));
    const direct = { sessionUpdate: "tool_call", toolCallId: "a", name: "mcp_clifunnel0_add_note", status: "in_progress", rawInput: { text: "x" } };
    const [start] = feed(direct);
    expect(start).toMatchObject({ type: "tool.start", name: "mcp_notes_add_note", mcp: { server: "notes", tool: "add_note" } });
    expect(feed({ ...direct, sessionUpdate: "tool_call_update", status: "completed", rawOutput: { output: "saved" } })).toEqual([{ type: "tool.end", id: "S:a", output: "saved" }]);
    const generic = { sessionUpdate: "tool_call", toolCallId: "b", name: "call_mcp_tool", status: "in_progress", rawInput: { ServerName: "clifunnel0", ToolName: "add_note", Arguments: { text: "x" } } };
    expect(feed(generic)[0]).toMatchObject({ name: "call_mcp_tool", input: { ServerName: "notes", ToolName: "add_note" }, mcp: { server: "notes", tool: "add_note" } });
    // A user's server of the same display name is not this run's: its tool is neither renamed nor tagged, and finishing stops the run.
    const theirs = { sessionUpdate: "tool_call", toolCallId: "c", name: "mcp_notes_add_note", status: "in_progress", rawInput: {} };
    expect(feed(theirs)[0]).not.toHaveProperty("mcp");
    expect(feed({ ...theirs, sessionUpdate: "tool_call_update", status: "completed" })).toEqual(["stopped"]);
  });
});

describe("Cursor Agent at none", () => {
  it("takes no MCP servers: the contract refuses them and no capability lists them", () => {
    expect(agentProvider.capabilities.mcpServersAtNone).toBeUndefined();
    expect(code(() => mcpServersFor(run("agent"), ["http", "stdio"], "Cursor Agent", agentProvider.capabilities.mcpServersAtNone ?? []))).toBe("invalid-selection");
  });

  it("refuses them through the funnel, before any process starts", async () => {
    const funnel = createFunnel({ providers: { agent: { ...agentProvider, detect: async () => ({ installed: true, testedRange: { min: "0" } }), models: async () => [{ id: "m", name: "M", provider: "agent", efforts: [], contextWindows: [], fast: false, source: "manifest" }] } } });
    await expect(funnel.run({ selection: { provider: "agent", model: "m", cwd: tmpdir(), access: "none" }, prompt: "x", mcpServers: servers })).rejects.toMatchObject({ code: "invalid-selection" });
  });

  it("keeps ask mode and the blanket MCP deny for every run", async () => {
    expect(accessFlags("none")).toEqual(["--mode", "ask"]);
    expect(NONE_PERMISSIONS.permissions.deny).toContain("Mcp(*:*)");
    process.env.XDG_CACHE_HOME = join(tmpdir(), "cf-mcp-none-cache");
    try {
      const dir = await agentNone();
      expect(JSON.parse(readFileSync(join(dir, ".cursor", "cli.json"), "utf8"))).toEqual(NONE_PERMISSIONS);
    } finally {
      delete process.env.XDG_CACHE_HOME;
    }
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

  it("reads Antigravity's print transport, where agy calls a server by its plugin name funnel_<name>", () => {
    expect(mcpCall("call_mcp_tool", { ServerName: "funnel_notes", ToolName: "add_note" }, names, "antigravity")).toEqual({ server: "notes", tool: "add_note" });
    expect(mcpCall("call_mcp_tool", { ServerName: "funnel_notes_two", ToolName: "t" }, names, "antigravity")).toEqual({ server: "notes_two", tool: "t" });
    // On another provider that name is not this run's server.
    expect(mcpCall("call_mcp_tool", { ServerName: "funnel_notes", ToolName: "add_note" }, names, "claude")).toBeUndefined();
    expect(mcpCall("call_mcp_tool", { ServerName: "funnel_theirs", ToolName: "t" }, names, "antigravity")).toBeUndefined();
  });

  it("tags a print-transport run's call through the funnel", async () => {
    const events: FunnelEvent[] = [{ type: "tool.start", id: "1", name: "call_mcp_tool", input: { ServerName: "funnel_notes", ToolName: "add_note", Arguments: {} } }];
    const out: FunnelEvent[] = [];
    for await (const e of tagMcpCalls((async function* () { yield* events; })(), ["notes"], "antigravity")) out.push(e);
    expect(out[0]).toMatchObject({ mcp: { server: "notes", tool: "add_note" } });
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
