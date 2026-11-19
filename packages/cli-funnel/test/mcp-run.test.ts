import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accessFlags, agentProvider, NONE_PERMISSIONS, noneWorkspace as agentNone } from "../src/providers/agent/index.js";
import { createFunnel } from "../src/funnel.js";
import { checkAcpServers, createAcpMapper, decidePermission, reserveServers } from "../src/providers/antigravity/acp/protocol.js";
import { denyCommand, exceptNames, hookDenies, NONE_MATCHER, noneHooks, noneWorkspace as agyNone, removeRunWorkspace, requireWorkingHook, sweepRunWorkspaces } from "../src/providers/antigravity/index.js";
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
  const RUN = "ab12cd34";
  /** A hook matcher is a Go regexp, where a leading `(?s)` lets `.` match a line break. JavaScript spells that as a flag. */
  const matches = (re: string, s: string) => (re.startsWith("(?s)") ? new RegExp(re.slice(4), "s") : new RegExp(re)).test(s);
  const hook = (run?: string) => (noneHooks("linux", run) as any)["cli-funnel-none"].PreToolUse[0];

  it("sends each server to agy under a reserved name with a part of this run only, and maps it back", () => {
    const r = reserveServers(Object.entries(servers!), RUN);
    expect(r.reserved).toEqual([`clifunnel${RUN}_0`, `clifunnel${RUN}_1`]);
    expect(r.callers.get(`clifunnel${RUN}_1`)).toBe("local");
    expect(r.acp).toEqual([
      { type: "http", name: `clifunnel${RUN}_0`, url: "http://127.0.0.1:9/mcp", headers: [{ name: "Authorization", value: "Bearer secret-token" }] },
      { name: `clifunnel${RUN}_1`, command: "node", args: ["s.js"], env: [{ name: "A", value: "b" }] },
    ]);
    // Another run gets other names, so nothing that exists beforehand can have one of them.
    expect(reserveServers(Object.entries(servers!), "00000000").reserved[0]).not.toBe(r.reserved[0]);
  });

  it("refuses a caller name that starts like a reserved one, and a tool timeout ACP has no field for", () => {
    const at = (s: object) => code(() => checkAcpServers(Object.entries(s) as [string, McpServer][]));
    for (const name of ["clifunnel0", "clifunnelab12cd34_0", "clifunnel", "CliFunnel1"]) expect(at({ [name]: servers!.notes }), name).toBe("invalid-selection");
    expect(at({ notes: servers!.notes, local: servers!.local })).toBe("ok");
    expect(at({ notes: { ...servers!.notes, toolTimeoutSec: 30 } })).toBe("unsupported");
  });

  describe("the hook of a run with servers", () => {
    const re = () => hook(RUN).matcher as string;

    it("is a fixed deny with no script: the same shell command as the hook of a run with no servers, and a matcher that leaves out only finish and this run's prefix", () => {
      const h = hook(RUN);
      expect(h.hooks[0].command).toContain("printf");
      expect(h.hooks[0].command).not.toContain("node");
      expect(h.hooks[0].command).not.toContain(process.execPath);
      expect(hook().hooks[0].command.replace(/'[^']*'$/, "")).toBe(h.hooks[0].command.replace(/'[^']*'$/, ""));
      expect(JSON.parse(h.hooks[0].command.match(/'(\{.*\})'$/)![1])).toMatchObject({ decision: "deny", reason: expect.stringContaining("start with mcp_") });
    });

    it("matches every tool name but finish and the run's own, so the hook denies them", () => {
      for (const left of ["finish", `mcp_clifunnel${RUN}_0_add_note`, `mcp_clifunnel${RUN}_12_t`, `mcp_clifunnel${RUN}_`]) expect(matches(re(), left), left).toBe(false);
      for (const hit of ["", "f", "finis", "finishx", "Finish", "call_mcp_tool", "run_command", "read_file", "write_file", "invoke_subagent",
        "mcp_notes_add_note", "mcp_clifunnel0_add_note", "mcp_clifunnel00000000_0_add_note", "mcp_clifunnel", `mcp_clifunnel${RUN}`, `mcp_clifunnel${RUN.slice(0, -1)}_0_x`, `xmcp_clifunnel${RUN}_0_x`, "mcp", "usersim_other"]) {
        expect(matches(re(), hit), hit).toBe(true);
      }
    });

    it("has an answer with nothing in it that cmd.exe reads as an operator, since on Windows the hook is an echo of it", () => {
      for (const run of [undefined, RUN]) {
        const command = (noneHooks("win32", run) as any)["cli-funnel-none"].PreToolUse[0].hooks[0].command as string;
        expect(command.startsWith("echo {")).toBe(true);
        expect(command.slice(5), String(run)).not.toMatch(/[<>&|^%]/);
      }
    });

    it("agrees with the matcher of a run with no servers on everything but the run's own tools", () => {
      const plain = hook().matcher as string;
      expect(plain).toBe(NONE_MATCHER);
      for (const s of ["finish", "", "f", "fini", "finishes", "write_file", "call_mcp_tool", "mcp_x_y"]) expect(matches(re(), s), s).toBe(matches(plain, s));
    });

    it("starts with (?s), so a name with a line break in it is refused", () => {
      const e = exceptNames(["finish"], ["mcp_a_"]);
      expect(e.startsWith("(?s)")).toBe(true);
      for (const hit of ["finishes\nx", "x\ny", "mcp_b_x\n", "finish\n"]) expect(matches(e, hit), JSON.stringify(hit)).toBe(true);
      for (const left of ["finish", "mcp_a_x\ny"]) expect(matches(e, left), JSON.stringify(left)).toBe(false);
    });

    it("builds the complement as a trie, for names and prefixes", () => {
      const e = exceptNames(["finish", "stop"], ["mcp_a_"]);
      for (const left of ["finish", "stop", "mcp_a_x", "mcp_a_"]) expect(matches(e, left), left).toBe(false);
      for (const hit of ["", "fin", "finishes", "sto", "stops", "mcp_a", "mcp_b_x", "x"]) expect(matches(e, hit), hit).toBe(true);
    });
  });

  describe("the self-test of a hook", () => {
    const withFakeSh = (body: string, fn: () => Promise<void>) => async () => {
      const dir = mkdtempSync(join(tmpdir(), "cf-fake-sh-"));
      writeFileSync(join(dir, "sh"), `#!/bin/sh.real\n`);
      // A `sh` that is first on the PATH and runs `body` instead of the command it is given.
      const real = "/bin/sh";
      writeFileSync(join(dir, "sh"), `#!${real}\n${body}\n`);
      chmodSync(join(dir, "sh"), 0o755);
      const old = process.env.PATH;
      process.env.PATH = `${dir}:${old}`;
      try {
        await fn();
      } finally {
        process.env.PATH = old;
      }
    };

    it("accepts the deny command as agy runs it, with a refused call on stdin", async () => {
      expect(await hookDenies(denyCommand("linux"), "linux")).toBe(true);
      expect(await hookDenies(denyCommand("linux", { decision: "deny", reason: "x" }), "linux")).toBe(true);
    });

    it("refuses a command that exits 0 and prints nothing, which agy reads as allow", async () => {
      for (const command of ["exit 0", "true", "cat >/dev/null", ":"]) expect(await hookDenies(command, "linux"), command).toBe(false);
    });

    it("refuses a command that prints something else, fails, or answers allow", async () => {
      for (const command of ["echo hello", "echo '{\"decision\":\"allow\"}'", "exit 3", "echo '{\"decision\":\"deny\"}'; exit 1", "sleep 0.1; echo not-json"]) expect(await hookDenies(command, "linux"), command).toBe(false);
    });

    it("stops the run with `unsupported` before anything starts when the shell runs nothing, the case of a host that cannot run what the hook needs", withFakeSh("exit 0", async () => {
      await expect(requireWorkingHook()).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("would read it as allow") });
      await expect(requireWorkingHook(RUN)).rejects.toMatchObject({ code: "unsupported" });
    }));

    it("passes when the shell does its job, and remembers it", async () => {
      await expect(requireWorkingHook()).resolves.toBeUndefined();
      await expect(requireWorkingHook(RUN)).resolves.toBeUndefined();
    });
  });

  it("gives a run with servers a folder of its own that holds the hook and the git marker, and a run with none the shared one", async () => {
    process.env.XDG_CACHE_HOME = join(tmpdir(), "cf-mcp-none-cache");
    try {
      const plain = await agyNone();
      const a = await agyNone(undefined, RUN);
      expect(a).not.toBe(plain);
      expect(await agyNone(undefined, "00000000")).not.toBe(a);
      expect(readdirSync(a).sort()).toEqual([".agents", ".git"]);
      expect(readdirSync(join(a, ".agents"))).toEqual(["hooks.json"]);
      expect(JSON.parse(readFileSync(join(a, ".agents", "hooks.json"), "utf8"))["cli-funnel-none"].PreToolUse[0].matcher).toBe(hook(RUN).matcher);
      expect(JSON.parse(readFileSync(join(plain, ".agents", "hooks.json"), "utf8"))["cli-funnel-none"].PreToolUse[0].matcher).toBe(NONE_MATCHER);
      // No name a caller can choose gives one run the folder of another.
      const folders = [plain, await agyNone("mcp"), await agyNone("x"), await agyNone("x", RUN), await agyNone("x-run-ab12cd34"), await agyNone("run-ab12cd34"), await agyNone("run"), await agyNone("run", "00000000"), a];
      expect(new Set(folders).size).toBe(folders.length);
      await removeRunWorkspace(a);
      expect(existsSync(a)).toBe(false);
    } finally {
      delete process.env.XDG_CACHE_HOME;
    }
  });

  it("sweeps the folders of runs that ended without cleaning up, and only the old ones", async () => {
    process.env.XDG_CACHE_HOME = join(tmpdir(), "cf-sweep-cache");
    try {
      const old = await agyNone(undefined, "00000001");
      const named = await agyNone("pyxis", "00000002");
      const fresh = await agyNone(undefined, "ffffffff");
      const shared = await agyNone();
      const longAgo = new Date(Date.now() - 3 * 24 * 3_600_000);
      for (const dir of [old, named]) utimesSync(dir, longAgo, longAgo);
      await sweepRunWorkspaces();
      expect(existsSync(old)).toBe(false);
      expect(existsSync(named)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(shared)).toBe(true);
    } finally {
      delete process.env.XDG_CACHE_HOME;
    }
  });

  it("allows a permission request for this run's reserved servers only, by the exact tool name, and never call_mcp_tool", () => {
    const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
    const reserved = new Set([`clifunnel${RUN}_0`]);
    const ask = (toolCall: unknown) => decidePermission({ toolCall, options }, reserved);
    const allow = { outcome: { outcome: "selected", optionId: "allow" } };
    const deny = { outcome: { outcome: "selected", optionId: "deny" } };
    expect(ask({ name: `mcp_clifunnel${RUN}_0_add_note`, rawInput: { text: "x" } })).toEqual(allow);
    expect(ask({ name: "call_mcp_tool", rawInput: { ServerName: `clifunnel${RUN}_0`, ToolName: "add_note" } })).toEqual(deny);
    expect(ask({ name: "call_mcp_tool", rawInput: { ServerName: "notes", ToolName: "x" } })).toEqual(deny);
    for (const name of ["mcp_notes_x", `mcp_clifunnel${RUN}_0`, `mcp_clifunnel${RUN}_1_x`, "mcp_clifunnel0_0_x", "run_command"]) expect(ask({ name }), name).toEqual(deny);
  });

  describe("the mapper and the guard", () => {
    const callers = new Map([[`clifunnel${RUN}_0`, "notes"]]);
    const make = () => {
      const mapper = createAcpMapper("S", { access: "none", mcp: callers });
      const guard = createNoneGuard((start) => start.name !== "finish" && !mapper.isMcp(start.id));
      const feed = (u: object): (FunnelEvent | "stopped")[] => mapper.update(u).flatMap((e): (FunnelEvent | "stopped")[] => (guard.check(e) ? ["stopped"] : [e]));
      return { mapper, feed };
    };
    const direct = { sessionUpdate: "tool_call", toolCallId: "a", name: `mcp_clifunnel${RUN}_0_add_note`, status: "in_progress", rawInput: { text: "x" } };

    it("shows the caller's own name, tags the call, and lets only those calls finish at none", () => {
      const { feed } = make();
      const [start] = feed(direct);
      expect(start).toMatchObject({ type: "tool.start", name: "mcp_notes_add_note", mcp: { server: "notes", tool: "add_note" } });
      expect(feed({ ...direct, sessionUpdate: "tool_call_update", status: "completed", rawOutput: { output: "saved" } })).toEqual([{ type: "tool.end", id: "S:a", output: "saved" }]);
      // A user's server of the same display name is not this run's: its tool is neither renamed nor tagged, and finishing stops the run.
      const theirs = { sessionUpdate: "tool_call", toolCallId: "c", name: "mcp_notes_add_note", status: "in_progress", rawInput: {} };
      expect(feed(theirs)[0]).not.toHaveProperty("mcp");
      expect(feed({ ...theirs, sessionUpdate: "tool_call_update", status: "completed" })).toEqual(["stopped"]);
    });

    it("does not stop a call of this run's server whose arguments arrive in a later update", () => {
      const { feed } = make();
      // The first update has no arguments yet, so nothing says whose call it is. The second names this run's server.
      const generic = { sessionUpdate: "tool_call", toolCallId: "g", name: "call_mcp_tool", status: "in_progress", rawInput: {} };
      expect(feed(generic)[0]).toMatchObject({ type: "tool.start", name: "call_mcp_tool" });
      feed({ ...generic, sessionUpdate: "tool_call_update", status: "in_progress", rawInput: { ServerName: `clifunnel${RUN}_0`, ToolName: "add_note", Arguments: {} } });
      expect(feed({ ...generic, sessionUpdate: "tool_call_update", status: "completed", rawInput: { ServerName: `clifunnel${RUN}_0`, ToolName: "add_note", Arguments: {} } })).toEqual([{ type: "tool.end", id: "S:g" }]);
      // And one that never names this run's server is stopped.
      const other = { sessionUpdate: "tool_call", toolCallId: "o", name: "call_mcp_tool", status: "in_progress", rawInput: {} };
      feed(other);
      expect(feed({ ...other, sessionUpdate: "tool_call_update", status: "completed", rawInput: { ServerName: "theirs", ToolName: "t" } })).toEqual(["stopped"]);
    });

    it("reports an allowed call that failed with no text as a failure, and a refused call that failed with no text as the hook's refusal", () => {
      const { feed } = make();
      feed(direct);
      const failed = feed({ ...direct, sessionUpdate: "tool_call_update", status: "failed" });
      expect(failed[0]).toMatchObject({ type: "tool.end", error: "tool failed" });
      const refused = { sessionUpdate: "tool_call", toolCallId: "r", name: "run_command", status: "in_progress", rawInput: {} };
      feed(refused);
      expect(feed({ ...refused, sessionUpdate: "tool_call_update", status: "failed" })[0]).toMatchObject({ type: "tool.end", error: expect.stringContaining("denied: denied by pre-tool hook") });
    });
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

  it("leaves the tagging to the mapper where the mapper is the only source, so a user's server with the caller's name is not tagged", async () => {
    const events: FunnelEvent[] = [
      { type: "tool.start", id: "1", name: "mcp_notes_add_note", input: {} },
      { type: "tool.start", id: "2", name: "mcp_notes_add_note", input: {}, mcp: { server: "notes", tool: "add_note" } },
    ];
    const run = async (fallback: boolean) => {
      const out: FunnelEvent[] = [];
      for await (const e of tagMcpCalls((async function* () { yield* events; })(), ["notes"], "antigravity", fallback)) out.push(e);
      return out;
    };
    // With the fallback on, the display name tags both. With it off, only the call the mapper tagged keeps its tag.
    expect((await run(true)).map((e) => "mcp" in e)).toEqual([true, true]);
    expect((await run(false)).map((e) => "mcp" in e)).toEqual([false, true]);
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
