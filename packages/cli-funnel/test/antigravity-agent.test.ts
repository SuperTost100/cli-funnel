import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collect } from "./helpers.js";
import { antigravityProvider, apiKeyEnv, buildArgs, createdSince, mcpConfig } from "../src/providers/antigravity/index.js";
import { createMapper, parseRm, parseTaskList, type MapperOptions } from "../src/providers/antigravity/parser.js";
import type { FunnelEvent, McpServer, RunInput } from "../src/types.js";

const fx = (n: string) => readFileSync(new URL(`./fixtures/antigravity/${n}`, import.meta.url), "utf8");
const events = (n: string, options?: MapperOptions): FunnelEvent[] => {
  const m = createMapper(options);
  return fx(n).split("\n").filter(Boolean).flatMap((l) => m.map(JSON.parse(l)));
};
const changes = (e: FunnelEvent[]) => e.filter((x) => x.type === "file.change").map(({ type: _, ...c }: any) => c);
const input = (over: Partial<RunInput["selection"]> = {}): RunInput => ({
  prompt: "hi",
  selection: { provider: "antigravity", model: "gemini-3.8-flash", effort: "low", cwd: "/tmp", access: "full", ...over },
});

describe("antigravity file changes", () => {
  it("maps a write, an edit and an rm from one run", () => {
    // Only new.txt was created during the run.
    const e = events("files.ndjson", { createdInRun: (p) => p === "/tmp/agyt/new.txt" });
    expect(changes(e)).toEqual([
      { id: "00000000-0000-4000-8000-000000000001:6", path: "/tmp/agyt/new.txt", kind: "add", status: "done" },
      { id: "00000000-0000-4000-8000-000000000001:8", path: "/tmp/agyt/existing.txt", kind: "update", status: "done" },
      { id: "00000000-0000-4000-8000-000000000001:10", path: "/tmp/agyt/gone.txt", kind: "delete", status: "done" },
    ]);
    // The change comes after the tool.end of the same call.
    const i = e.findIndex((x) => x.type === "tool.end" && x.id.endsWith(":6"));
    expect(e[i + 1]).toMatchObject({ type: "file.change", path: "/tmp/agyt/new.txt" });
  });

  it("reports a write over a file from before the run as an update", () => {
    const e = events("files.ndjson", { createdInRun: () => false });
    expect(changes(e)[0]).toMatchObject({ path: "/tmp/agyt/new.txt", kind: "update" });
  });

  it("reports a write as an add when it cannot tell", () => {
    expect(changes(events("files.ndjson"))[0]).toMatchObject({ kind: "add" });
    expect(changes(events("files.ndjson", { createdInRun: () => undefined }))[0]).toMatchObject({ kind: "add" });
  });

  it("follows one file through a run: add, rewrite, delete, add again", () => {
    const m = createMapper({ createdInRun: () => true });
    m.map({ event: "init", conversation_id: "c", init: { cwd: "/w" } });
    let n = 0;
    const done = (tool: string, parameters: object, output?: string) =>
      m.map({ event: "step_update", step_update: { conversation_id: "c", step_index: ++n, state: "DONE", step_type: "tool", tool_name: tool, tool_info: { name: tool, parameters, output } } });
    const kinds = [
      done("write_file", { Path: "/w/a.txt" }),
      done("write_file", { Path: "/w/a.txt" }),
      done("run_command", { CommandLine: "rm a.txt" }, "Command exited with code 0.\n\nNo output from the command."),
      done("write_file", { Path: "/w/a.txt" }),
    ].map((e) => changes(e)[0]?.kind);
    expect(kinds).toEqual(["add", "update", "delete", "add"]);
  });

  it("maps a failed edit", () => {
    const e = events("file-failed.ndjson");
    expect(changes(e)).toEqual([{ id: "00000000-0000-4000-8000-000000000001:2", path: "/tmp/agyt/missing.txt", kind: "update", status: "failed" }]);
    expect(e.find((x) => x.type === "tool.end")).toMatchObject({ error: expect.stringContaining("does not exist") });
  });

  it("maps a write refused by a hook as declined", () => {
    const e = events("file-hook-denied.ndjson");
    expect(changes(e)).toEqual([{ id: "00000000-0000-4000-8000-000000000001:2", path: "/tmp/agyt/hello.txt", kind: "add", status: "declined" }]);
  });

  it("maps a write refused by a permission check as declined, with the older TargetFile parameter", () => {
    const e = events("denied.ndjson");
    expect(changes(e)).toEqual([{ id: "00000000-0000-4000-8000-000000000001:2", path: "/tmp/agyt/hello.txt", kind: "add", status: "declined" }]);
  });

  it("maps a write from the older TargetFile parameter", () => {
    expect(changes(events("tool.ndjson"))).toEqual([{ id: "00000000-0000-4000-8000-000000000001:2", path: "/tmp/agyt/hello.txt", kind: "add", status: "done" }]);
  });

  it("maps an rm the headless mode refused as declined, resolved against the run's folder", () => {
    const e = events("rm-denied.ndjson");
    expect(changes(e)).toEqual([{ id: "00000000-0000-4000-8000-000000000001:2", path: "/tmp/agyt/gone.txt", kind: "delete", status: "declined" }]);
    expect(e.at(-1)).toMatchObject({ type: "done", finishReason: "denied" });
  });

  it("maps an rm that exited with an error as failed", () => {
    const line = (state: string, output?: string) =>
      JSON.stringify({ event: "step_update", step_update: { conversation_id: "c", step_index: 1, state, step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "rm -rf /tmp/agyt/a /tmp/agyt/b" }, output } } });
    const m = createMapper();
    m.map({ event: "init", conversation_id: "c", init: { cwd: "/tmp/agyt" } });
    const e = [...m.map(JSON.parse(line("ACTIVE"))), ...m.map(JSON.parse(line("DONE", "Command exited with code 1.\n\nCommand output:\nrm: cannot remove\r\n")))];
    expect(changes(e)).toEqual([
      { id: "c:1", path: "/tmp/agyt/a", kind: "delete", status: "failed" },
      { id: "c:1", path: "/tmp/agyt/b", kind: "delete", status: "failed" },
    ]);
  });

  it("emits nothing for shell commands that are not a plain rm", () => {
    const e = events("files.ndjson");
    expect(changes(e).filter((c) => c.kind === "delete")).toHaveLength(1);
    expect(changes(events("rm-denied.ndjson")).length).toBe(1);
  });
});

describe("createdSince", () => {
  const file = join(mkdtempSync(join(tmpdir(), "cf-agy-born-")), "f.txt");
  writeFileSync(file, "x");

  it.skipIf(statSync(file).birthtimeMs <= 0)("tells a file made during the run from one made before it", () => {
    expect(createdSince(Date.now() - 60_000)(file)).toBe(true);
    expect(createdSince(Date.now() + 60_000)(file)).toBe(false);
  });

  it("gives no answer for a file that is gone", () => {
    expect(createdSince(0)(join(file, "missing"))).toBeUndefined();
  });
});

describe("parseRm", () => {
  it("takes the paths of a plain rm", () => {
    expect(parseRm("rm /tmp/a.txt", undefined)).toEqual(["/tmp/a.txt"]);
    expect(parseRm("rm -f a.txt sub/b.txt", "/work")).toEqual(["/work/a.txt", "/work/sub/b.txt"]);
    expect(parseRm("  rm -rf -- /tmp/dir \n", undefined)).toEqual(["/tmp/dir"]);
  });

  it("refuses anything the words alone do not describe", () => {
    for (const c of ["rm 'a b'", 'rm "a"', "rm *.txt", "rm a && rm b", "rm a; ls", "rm $HOME/a", "rm a | cat", "rm a > out", "rm ~/a", "rm {a,b}", "cd /x && rm a", "ls", "rm", "rm -rf", "rmdir a", "sudo rm a"]) {
      expect(parseRm(c, "/work"), c).toBeUndefined();
    }
  });

  it("refuses a relative path when there is no folder to resolve it against", () => {
    expect(parseRm("rm a.txt", undefined)).toBeUndefined();
  });
});

describe("antigravity plans", () => {
  const brainDir = "/home/user/.gemini/antigravity-cli/brain";
  const done = fx("plan-task.md");
  const planOf = (e: FunnelEvent[]) => e.filter((x) => x.type === "plan");

  it("parses a checklist into steps", () => {
    expect(parseTaskList(done).map((s) => s.status)).toEqual(["done", "done", "done"]);
    const nested = "# T\n\n- [ ] **Plan**\n  - [x] Read `a.py`\n  - [/] Write it\n- [ ] Verify\nnot an item\n* [X] star item\n- [?] odd marker\n";
    expect(parseTaskList(nested)).toEqual([
      { text: "Read `a.py`", status: "done" },
      { text: "Write it", status: "in_progress" },
      { text: "Verify", status: "pending" },
      { text: "star item", status: "done" },
    ]);
    expect(parseTaskList("no list here")).toEqual([]);
  });

  it("emits a plan when the agent writes its task list, and keeps the task file out of the file changes", () => {
    const reads: string[] = [];
    const e = events("plan.ndjson", { brainDir, readText: (p) => (reads.push(p), done) });
    // The agent wrote task.md twice. The second write leaves the list as it was, so it is one plan.
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBe(`${brainDir}/00000000-0000-4000-8000-000000000001/task.md`);
    expect(planOf(e)).toEqual([{ type: "plan", steps: parseTaskList(done) }]);
    expect(changes(e).map((c) => c.path)).toEqual(["/tmp/agyt/calc.py", "/tmp/agyt/test_calc.py"]);
  });

  it("emits a plan each time the list changes", () => {
    const lists = [done.replaceAll("[x]", "[ ]"), done];
    const e = events("plan.ndjson", { brainDir, readText: () => lists.shift() });
    const plans = planOf(e) as { steps: { status: string }[] }[];
    expect(plans.map((p) => p.steps.map((s) => s.status))).toEqual([["pending", "pending", "pending"], ["done", "done", "done"]]);
  });

  it("emits no plan without a brain folder or a reader, or when the file cannot be read", () => {
    expect(planOf(events("plan.ndjson", { readText: () => done }))).toEqual([]);
    expect(planOf(events("plan.ndjson", { brainDir }))).toEqual([]);
    expect(planOf(events("plan.ndjson", { brainDir, readText: () => undefined }))).toEqual([]);
  });

  it("reads only the task list of the run's own conversation", () => {
    const m = createMapper({ brainDir, readText: () => done });
    m.map({ event: "init", conversation_id: "a", init: { cwd: "/tmp" } });
    const write = (path: string) => m.map({ event: "step_update", step_update: { conversation_id: "a", step_index: 1, state: "DONE", step_type: "tool", tool_name: "write_file", tool_info: { name: "write_file", parameters: { Path: path } } } });
    expect(write(`${brainDir}/other/task.md`).filter((x) => x.type === "plan")).toEqual([]);
    expect(write(`${brainDir}/a/implementation_plan.md`).filter((x) => x.type === "plan")).toEqual([]);
    expect(write(`${brainDir}/a/task.md`).filter((x) => x.type === "plan")).toHaveLength(1);
  });
});

describe("antigravity session auth", () => {
  it("says api-key when the run was given a key, and nothing otherwise", () => {
    expect(events("api-key-error.ndjson", { auth: "api-key" })[0]).toMatchObject({ type: "session", auth: "api-key" });
    const plain = events("api-key-error.ndjson")[0] as Record<string, unknown>;
    expect(plain.type).toBe("session");
    expect("auth" in plain).toBe(false);
  });

  it("maps a rejected key to an error", () => {
    expect(events("api-key-error.ndjson").at(-1)).toMatchObject({ type: "error", code: "cli-failed", message: expect.stringContaining("API key not valid") });
  });
});

describe("antigravity mcp", () => {
  it("writes http servers as url and headers, stdio servers as command, args and env", () => {
    const servers: [string, McpServer][] = [
      ["app", { type: "http", url: "http://127.0.0.1:7777/mcp", headers: { Authorization: "Bearer t" }, toolTimeoutSec: 899.5, autoApprove: true }],
      ["local", { type: "stdio", command: "node", args: ["s.js"], env: { A: "b" } }],
      ["bare", { type: "http", url: "https://x.test/mcp" }],
    ];
    expect(mcpConfig(servers)).toEqual({
      mcpServers: {
        app: { url: "http://127.0.0.1:7777/mcp", headers: { Authorization: "Bearer t" }, timeoutSeconds: 900 },
        local: { command: "node", args: ["s.js"], env: { A: "b" } },
        bare: { url: "https://x.test/mcp" },
      },
    });
  });

  it("adds the plugin folder to the workspace", () => {
    expect(buildArgs(input(), [], "linux", undefined, undefined, "/tmp/p")).toContain("--add-dir=/tmp/p");
    expect(buildArgs(input()).some((a) => a.startsWith("--add-dir"))).toBe(false);
  });

  it("offers both server types and the other agent features", () => {
    const c = antigravityProvider.capabilities;
    expect(c.mcpServers).toEqual(["http", "stdio"]);
    expect([c.apiKey, c.plan, c.fileChanges]).toEqual([true, true, true]);
    expect(c.questions).toBeFalsy();
    expect(c.approvals).toBe(false);
  });

  it("reports the MCP call that accept-edits refuses as denied", () => {
    const e = events("mcp-denied.ndjson");
    expect(e.filter((x) => x.type === "tool.start").map((x: any) => x.name)).toEqual(["read_file", "call_mcp_tool"]);
    expect(e.find((x) => x.type === "tool.end" && x.error)).toMatchObject({ error: expect.stringMatching(/^denied: permission check failed for mcp/) });
    expect(e.at(-1)).toMatchObject({ type: "done", finishReason: "denied" });
  });

  it("maps a call to an attached server", () => {
    const e = events("mcp-call.ndjson");
    expect(e.find((x) => x.type === "tool.start" && x.name === "call_mcp_tool")).toMatchObject({ input: { ServerName: "agyprobe_probe", ToolName: "agyprobe_ping" } });
    expect(e.at(-1)).toMatchObject({ type: "done", finishReason: "stop", text: expect.stringContaining("tangerine") });
  });
});

// The fake agy is a shell script that uses GNU stat.
describe.skipIf(process.platform !== "linux")("antigravity run with a fake agy", () => {
  const oldCache = process.env.XDG_CACHE_HOME;
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGY_BIN;
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCache;
  });

  /** A fake agy that logs its arguments, its environment and the MCP plugin folder it was given, then answers. */
  function fakeAgy() {
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cf-agy-cache-"));
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    const bin = join(dir, "agy");
    const log = join(dir, "log");
    writeFileSync(
      bin,
      `#!/bin/sh
for a in "$@"; do echo "arg:$a" >> ${log}; done
echo "key:$GEMINI_API_KEY" >> ${log}
echo "home:$HOME" >> ${log}
echo "profile:$USERPROFILE" >> ${log}
echo "cwd:$PWD" >> ${log}
[ -f "$HOME/.gemini/antigravity-cli/settings.json" ] && echo "settings:$(tr -d ' \\n' < "$HOME/.gemini/antigravity-cli/settings.json")" >> ${log}
for a in "$@"; do case "$a" in --add-dir=*)
  d="\${a#--add-dir=}"
  p="$d/.agents/plugins/funnel"
  echo "dir:$d" >> ${log}
  echo "plugin:$(tr -d '\\n' < "$p/plugin.json")" >> ${log}
  echo "servers:$(tr -d '\\n' < "$p/mcp_config.json")" >> ${log}
  echo "mode:$(stat -c %a "$p/mcp_config.json") $(stat -c %a "$d")" >> ${log}
;; esac; done
echo '{"event":"init","conversation_id":"c1","init":{"model":"m","cwd":"'"$PWD"'"}}'
echo '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'
`,
    );
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGY_BIN = bin;
    return { dir, lines: () => readFileSync(log, "utf8").trim().split("\n") };
  }
  const run = (over: Partial<RunInput> = {}, selection: Partial<RunInput["selection"]> = {}): RunInput => ({
    ...input(selection),
    selection: { provider: "antigravity", model: "m", cwd: mkdtempSync(join(tmpdir(), "cf-agy-cwd-")), access: "full", ...selection },
    ...over,
  });
  const drain = async (r: RunInput) => {
    const out: FunnelEvent[] = [];
    for await (const e of antigravityProvider.run(r)) out.push(e);
    return out;
  };

  it("attaches MCP servers through a private plugin folder that is gone after the run", async () => {
    const agy = fakeAgy();
    const cwd = mkdtempSync(join(tmpdir(), "cf-agy-cwd-"));
    await drain(run({ mcpServers: { app: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer secret" } }, local: { type: "stdio", command: "node", args: ["s.js"] } } }, { cwd }));
    const lines = agy.lines();
    const dir = lines.find((l) => l.startsWith("dir:"))!.slice(4);
    expect(lines).toContain(`arg:--add-dir=${dir}`);
    // The run stays in the user's folder. Only the plugin folder is added to the workspace.
    expect(lines.find((l) => l.startsWith("cwd:"))).toMatch(new RegExp(`${cwd.replace(/^\/tmp/, "")}$`));
    expect(lines).toContain('plugin:{"name":"funnel"}');
    expect(JSON.parse(lines.find((l) => l.startsWith("servers:"))!.slice(8))).toEqual({
      mcpServers: { app: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer secret" } }, local: { command: "node", args: ["s.js"] } },
    });
    expect(lines).toContain("mode:600 700");
    expect(lines.join("\n")).not.toContain(homedir() + "/.gemini");
    expect(existsSync(dir)).toBe(false);
    // The caller's project got nothing.
    expect(existsSync(join(cwd, ".agents"))).toBe(false);
  });

  it("refuses MCP servers below full access, and refuses stdio servers without starting agy", async () => {
    const agy = fakeAgy();
    const http: RunInput["mcpServers"] = { app: { type: "http", url: "http://127.0.0.1:1/mcp" } };
    await expect(drain(run({ mcpServers: http }, { access: "accept-edits" }))).rejects.toThrow(/not allowed at access "accept-edits"/);
    await expect(drain(run({ mcpServers: http }, { access: "none" }))).rejects.toThrow(/none/);
    await expect(drain(run({ mcpServers: { s: { type: "stdio", command: "x" } } }, { access: "accept-edits" }))).rejects.toThrow(/stdio/);
    expect(existsSync(join(agy.dir, "log"))).toBe(false);
  });

  it("removes the plugin folder when the run fails to start", async () => {
    fakeAgy();
    const before = new Set(readdirTmp());
    await expect(drain(run({ mcpServers: { app: { type: "http", url: "http://127.0.0.1:1/mcp" } }, providerOptions: { antigravity: { addDirs: ["relative"] } } }))).rejects.toThrow(/absolute/);
    expect(readdirTmp().filter((d) => !before.has(d))).toEqual([]);
  });

  it("runs on an API key in its own home folder and leaves the user's agy settings alone", async () => {
    const agy = fakeAgy();
    const realSettings = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
    const settingsBefore = existsSync(realSettings) ? readFileSync(realSettings, "utf8") : undefined;
    const out = await drain(run({ apiKey: "AIza-test-key", env: { HOME: "/should/not/win", KEEP: "1" } }));
    const lines = agy.lines();
    const home = lines.find((l) => l.startsWith("home:"))!.slice(5);
    expect(home).toContain(join(process.env.XDG_CACHE_HOME!, "cli-funnel", "workspaces"));
    expect(lines).toContain("key:AIza-test-key");
    expect(lines).toContain(`profile:${home}`);
    expect(lines).toContain('settings:{"modelProvider":"gemini"}');
    // The key goes in the environment only.
    expect(lines.filter((l) => l.startsWith("arg:")).join(" ")).not.toContain("AIza-test-key");
    expect(out[0]).toMatchObject({ type: "session", sessionId: "c1", auth: "api-key" });
    expect(JSON.stringify(out)).not.toContain("AIza-test-key");
    expect(existsSync(realSettings) ? readFileSync(realSettings, "utf8") : undefined).toBe(settingsBefore);
  });

  it("keeps the real home and reports no auth when there is no key", async () => {
    const agy = fakeAgy();
    const out = await drain(run());
    const lines = agy.lines();
    expect(lines).toContain(`home:${process.env.HOME}`);
    expect(lines).not.toContain('settings:{"modelProvider":"gemini"}');
    expect("auth" in (out[0] as object)).toBe(false);
  });

  it("names the Gemini API key as the sign-in method only when the setting and the variable are both there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    const bin = join(dir, "agy");
    writeFileSync(bin, `#!/bin/sh\nprintf 'gemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\n'\n`);
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGY_BIN = bin;
    const oldHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "cf-agy-home-"));
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), '{"modelProvider":"gemini"}');
    process.env.HOME = home;
    try {
      expect(await antigravityProvider.authStatus()).toMatchObject({ loggedIn: true, method: "Google account" });
      process.env.GEMINI_API_KEY = "k";
      expect(await antigravityProvider.authStatus()).toMatchObject({ method: "Gemini API key" });
      writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "{}");
      expect(await antigravityProvider.authStatus()).toMatchObject({ method: "Google account" });
    } finally {
      delete process.env.GEMINI_API_KEY;
      process.env.HOME = oldHome;
    }
  });

  it("builds the key environment without touching the caller's other variables", () => {
    expect(apiKeyEnv("k", "/h", { A: "1", HOME: "/x" })).toEqual({ A: "1", GEMINI_API_KEY: "k", HOME: "/h", USERPROFILE: "/h" });
  });

  function readdirTmp(): string[] {
    return readdirSync(tmpdir()).filter((d) => d.startsWith("cli-funnel-agy-mcp-"));
  }
});

// Live tests spend a few tokens of the signed-in account. Each folder is a fresh temp folder.
describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1")("antigravity agent features live", () => {
  const live = (cwd: string, prompt: string, extra: Partial<RunInput> = {}): RunInput => ({
    ...input({ cwd, model: "gemini-3.8-flash", effort: "low", access: "full" }),
    prompt,
    ...extra,
  });

  it("reports file changes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cf-agy-live-"));
    writeFileSync(join(cwd, "existing.txt"), "old content\n");
    writeFileSync(join(cwd, "gone.txt"), "x\n");
    const r = await collect(
      antigravityProvider.run(live(cwd, "Use your file tools: create new.txt containing 'hello'; change existing.txt so it says 'updated' instead of 'old content'; delete gone.txt. Reply with just: done.")),
      live(cwd, ""),
    );
    const byPath = Object.fromEntries((r.fileChanges ?? []).map((c) => [c.path.slice(cwd.length + 1), c]));
    expect(byPath["new.txt"]).toMatchObject({ kind: "add", status: "done" });
    expect(byPath["existing.txt"]).toMatchObject({ kind: "update", status: "done" });
    expect(byPath["gone.txt"]).toMatchObject({ kind: "delete", status: "done" });
    expect(existsSync(join(cwd, "gone.txt"))).toBe(false);
  }, 180_000);

  it("reports the task list as a plan", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cf-agy-live-"));
    const r = await collect(
      antigravityProvider.run(live(cwd, "Create a.txt containing 'a', then b.txt containing 'b'. Keep a task list in a task.md artifact and update it as you go. Reply with just: done.")),
      live(cwd, ""),
    );
    expect(r.plan?.length).toBeGreaterThan(0);
    expect(r.plan!.every((s) => ["pending", "in_progress", "done"].includes(s.status))).toBe(true);
  }, 180_000);

  it("calls an HTTP MCP server with its headers", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = body ? JSON.parse(body) : {};
        if (msg.method === "tools/call") seen.push(String(req.headers.authorization));
        if (req.method !== "POST") return void res.writeHead(405).end();
        if (msg.id === undefined) return void res.writeHead(202).end();
        const result =
          msg.method === "initialize"
            ? { protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } }
            : msg.method === "tools/list"
              ? { tools: [{ name: "cf_ping", description: "Returns the secret word. Takes no arguments.", inputSchema: { type: "object", properties: {} } }] }
              : { content: [{ type: "text", text: "secret word: tangerine" }] };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const cwd = mkdtempSync(join(tmpdir(), "cf-agy-live-"));
      const mcpServers = { probe: { type: "http" as const, url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer cf-live-token" } } };
      const r = await collect(
        antigravityProvider.run(live(cwd, "Call the MCP tool cf_ping with call_mcp_tool (ServerName funnel_probe). Do not use the shell. Tell me the secret word it returns.", { mcpServers })),
        live(cwd, "", { mcpServers }),
      );
      expect(seen).toEqual(["Bearer cf-live-token"]);
      expect(r.text).toMatch(/tangerine/i);
      expect(existsSync(join(cwd, ".agents"))).toBe(false);
    } finally {
      server.close();
    }
  }, 180_000);
});

const GEMINI_KEY = process.env.CLI_FUNNEL_TEST_GEMINI_KEY;
describe.skipIf(!GEMINI_KEY)("antigravity api key live", () => {
  it("answers on the key and leaves the saved login alone", async () => {
    const dir = join(homedir(), ".gemini", "antigravity-cli");
    const files = ["settings.json", "antigravity-oauth-token"].map((f) => join(dir, f));
    const digest = () => files.map((f) => (existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : "-"));
    const before = digest();
    const cwd = mkdtempSync(join(tmpdir(), "cf-agy-live-"));
    mkdirSync(cwd, { recursive: true });
    const run: RunInput = { ...input({ cwd, model: "gemini-3.8-flash", effort: "low", access: "none" }), prompt: "Reply with the word OK", apiKey: GEMINI_KEY };
    const r = await collect(antigravityProvider.run(run), run);
    expect(r.text).toMatch(/OK/);
    expect(r.auth).toBe("api-key");
    expect(digest()).toEqual(before);
  }, 120_000);
});
