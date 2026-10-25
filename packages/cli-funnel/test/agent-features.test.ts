import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentProvider, buildArgs } from "../src/providers/agent/index.js";
import { attachMcp, mcpPlugin } from "../src/providers/agent/mcp.js";
import { StreamMapper, type MapperOptions } from "../src/providers/agent/parser.js";
import { mcpServersFor } from "../src/providers/options.js";
import { collect } from "./helpers.js";
import type { FunnelEvent, McpServer, RunInput } from "../src/types.js";

const lines = (name: string) =>
  readFileSync(new URL(`./fixtures/agent/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function replay(name: string, options?: MapperOptions): FunnelEvent[] {
  const mapper = new StreamMapper(options);
  return lines(name).flatMap((l) => mapper.map(l));
}

const ofType = <T extends FunnelEvent["type"]>(events: FunnelEvent[], type: T) => events.filter((e): e is Extract<FunnelEvent, { type: T }> => e.type === type);

const sel = (o: Partial<RunInput["selection"]> = {}): RunInput["selection"] => ({ provider: "agent", model: "composer-2.5", cwd: "/tmp", access: "full", ...o });

describe("plan events", () => {
  it("maps the todo list, with the whole merged list each time", () => {
    const plans = ofType(replay("todos-and-edits.ndjson"), "plan");
    expect(plans.map((p) => p.steps.map((s) => s.status))).toEqual([
      ["in_progress", "pending", "pending"],
      ["done", "in_progress", "pending"],
      // The last update sent only two items with merge on. The result lists all three.
      ["done", "done", "done"],
    ]);
    expect(plans[0]!.steps.map((s) => s.text)).toEqual(["Create a.txt containing hi", "Edit old.txt to say new", "Delete a.txt"]);
  });

  it("maps the plan made in plan mode, with its overview", () => {
    const plans = ofType(replay("plan-mode.ndjson"), "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]!.steps).toHaveLength(3);
    expect(plans[0]!.steps.every((s) => s.status === "pending")).toBe(true);
    expect(plans[0]!.explanation).toContain("hello()");
  });

  it("leaves out cancelled items and ignores a failed update", () => {
    const mapper = new StreamMapper();
    const done = (result: unknown) => ({ type: "tool_call", subtype: "completed", call_id: "t", tool_call: { updateTodosToolCall: { args: {}, result } } });
    const todo = (content: string, status: string) => ({ id: content, content, status });
    const out = mapper.map(done({ success: { todos: [todo("a", "TODO_STATUS_CANCELLED"), todo("b", "TODO_STATUS_COMPLETED")] } }));
    expect(ofType(out, "plan")[0]!.steps).toEqual([{ text: "b", status: "done" }]);
    expect(ofType(mapper.map(done({ error: { error: "no" } })), "plan")).toEqual([]);
  });

  it("flags the capability", () => {
    expect(agentProvider.capabilities.plan).toBe(true);
  });
});

describe("file changes", () => {
  it("maps add, update and delete from the results", () => {
    const changes = ofType(replay("todos-and-edits.ndjson"), "file.change");
    expect(changes.map(({ id: _, type: __, ...c }) => c)).toEqual([
      { path: "/home/user/project/plan/a.txt", kind: "add", status: "done" },
      { path: "/home/user/project/plan/old.txt", kind: "update", status: "done" },
      { path: "/home/user/project/plan/a.txt", kind: "delete", status: "done" },
    ]);
    const starts = ofType(replay("todos-and-edits.ndjson"), "tool.start");
    expect(changes[0]!.id).toBe(starts.find((s) => s.name === "edit")!.id);
  });

  it("reads the files of a patch-style result", () => {
    const changes = ofType(replay("edit-read.ndjson"), "file.change");
    expect(changes).toMatchObject([{ path: "/tmp/cf-agent-test/a.txt", kind: "add", status: "done" }]);

    const mapper = new StreamMapper();
    mapper.map({ type: "system", subtype: "init", session_id: "s", cwd: "/w" });
    const message = "Success. Updated the following files:\nA /w/new.txt\nM src/old.ts\nD /w/gone.txt";
    const out = mapper.map({ type: "tool_call", subtype: "completed", call_id: "p", tool_call: { editToolCall: { args: {}, result: { success: { message } } } } });
    expect(ofType(out, "file.change").map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "/w/new.txt", kind: "add" },
      { path: "/w/src/old.ts", kind: "update" },
      { path: "/w/gone.txt", kind: "delete" },
    ]);
  });

  it("uses the existence check from when the edit started when the result is silent", () => {
    const edit = (path: string) => [
      { type: "system", subtype: "init", session_id: "s", cwd: "/w" },
      { type: "tool_call", subtype: "started", call_id: "e", tool_call: { editToolCall: { args: { path } } } },
      { type: "tool_call", subtype: "completed", call_id: "e", tool_call: { editToolCall: { args: { path }, result: { success: { path, linesAdded: 1, linesRemoved: 0 } } } } },
    ];
    const seen: string[] = [];
    const run = (exists: boolean) => {
      const mapper = new StreamMapper({ exists: (p) => (seen.push(p), exists) });
      return ofType(edit("x.txt").flatMap((l) => mapper.map(l)), "file.change");
    };
    expect(run(false)).toMatchObject([{ path: "/w/x.txt", kind: "add", status: "done" }]);
    expect(run(true)).toMatchObject([{ path: "/w/x.txt", kind: "update", status: "done" }]);
    expect(seen).toEqual(["/w/x.txt", "/w/x.txt"]);
  });

  it("marks changes a permission rule refused as declined, with a relative path made absolute", () => {
    const events = replay("edit-denied.ndjson", { exists: () => false });
    const changes = ofType(events, "file.change");
    expect(changes.map(({ id: _, type: __, ...c }) => c)).toEqual([
      { path: "/home/user/project/deny/notes.txt", kind: "add", status: "declined" },
      { path: "/home/user/project/deny/old.txt", kind: "delete", status: "declined" },
      { path: "/home/user/project/deny/notes.txt", kind: "add", status: "declined" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "denied" });
  });

  it("marks changes the operating system or the file refused as failed, not declined", () => {
    const events = replay("edit-failed.ndjson", { exists: () => false });
    const changes = ofType(events, "file.change");
    expect(changes.map(({ id: _, type: __, ...c }) => c)).toEqual([
      { path: "/home/user/project/fail/ro/x.txt", kind: "add", status: "failed" },
      { path: "/home/user/project/fail/missing.txt", kind: "delete", status: "failed" },
    ]);
    expect(ofType(events, "tool.end").some((e) => e.error?.startsWith("denied:"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
  });

  it("emits nothing for reads, searches and calls without a result", () => {
    const events = replay("edit-read.ndjson").filter((e) => e.type === "file.change");
    expect(events).toHaveLength(1);
    const mapper = new StreamMapper();
    expect(mapper.map({ type: "tool_call", subtype: "completed", call_id: "e", tool_call: { editToolCall: { args: { path: "/a" } } } }).map((e) => e.type)).toEqual(["tool.end"]);
  });

  it("flags the capability and folds changes into the result", async () => {
    expect(agentProvider.capabilities.fileChanges).toBe(true);
    async function* gen() {
      yield* replay("todos-and-edits.ndjson");
    }
    const res = await collect(gen(), { selection: sel(), prompt: "x" });
    expect(res.fileChanges?.map((c) => c.kind)).toEqual(["add", "update", "delete"]);
    expect(res.plan?.map((s) => s.status)).toEqual(["done", "done", "done"]);
  });
});

describe("questions", () => {
  it("shows a skipped question as a tool error that is not a permission denial", () => {
    const events = replay("ask-question-skipped.ndjson");
    const end = ofType(events, "tool.end")[0]!;
    expect(end.error).toBe("Questions skipped by the user, continue with the information you already have");
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
    expect(events.some((e) => e.type === "question.request")).toBe(false);
  });

  it("does not offer questions", () => {
    expect(agentProvider.capabilities.questions).toBeFalsy();
  });
});

describe("auth in the session event", () => {
  const init = (apiKeySource: string) => new StreamMapper().map({ type: "system", subtype: "init", session_id: "s", apiKeySource });

  it("tells the saved login from a key", () => {
    expect(init("login")).toEqual([{ type: "session", sessionId: "s", auth: "account" }]);
    expect(init("env")).toEqual([{ type: "session", sessionId: "s", auth: "api-key" }]);
    expect(init("flag")).toEqual([{ type: "session", sessionId: "s", auth: "api-key" }]);
    expect(init("something-new")).toEqual([{ type: "session", sessionId: "s" }]);
  });
});

describe("MCP servers", () => {
  const input = (access: RunInput["selection"]["access"], mcpServers: Record<string, McpServer>): RunInput => ({ selection: sel({ access }), prompt: "x", mcpServers });
  const http: McpServer = { type: "http", url: "http://127.0.0.1:7777/mcp?key=urlsecret", headers: { Authorization: "Bearer sekrit-token" } };
  const stdio: McpServer = { type: "stdio", command: "node", args: ["server.js", "--token=argsecret"], env: { TOKEN: "envsecret" } };

  it("puts every value in the environment and none in the config file", () => {
    const { config, env } = mcpPlugin(mcpServersFor(input("full", { app: http, local: stdio }), ["http", "stdio"]));
    const json = JSON.stringify(config);
    for (const secret of ["urlsecret", "sekrit-token", "argsecret", "envsecret", "127.0.0.1", "server.js"]) expect(json).not.toContain(secret);
    expect(config.mcpServers.app).toEqual({ url: "${env:CLI_FUNNEL_MCP_0_URL}", headers: { Authorization: "${env:CLI_FUNNEL_MCP_0_H0}" } });
    expect(config.mcpServers.local).toEqual({
      command: "${env:CLI_FUNNEL_MCP_1_CMD}",
      args: ["${env:CLI_FUNNEL_MCP_1_A0}", "${env:CLI_FUNNEL_MCP_1_A1}"],
      env: { TOKEN: "${env:CLI_FUNNEL_MCP_1_E0}" },
    });
    expect(env).toMatchObject({
      CLI_FUNNEL_MCP_0_URL: http.type === "http" ? http.url : "",
      CLI_FUNNEL_MCP_0_H0: "Bearer sekrit-token",
      CLI_FUNNEL_MCP_1_CMD: "node",
      CLI_FUNNEL_MCP_1_A1: "--token=argsecret",
      CLI_FUNNEL_MCP_1_E0: "envsecret",
    });
  });

  it("refuses a tool timeout, which the CLI cannot set", () => {
    expect(() => mcpPlugin([["app", { ...http, toolTimeoutSec: 60 } as McpServer]])).toThrow(expect.objectContaining({ code: "unsupported" }));
  });

  describe("plugin folder", () => {
    let cache: string | undefined;
    beforeEach(() => {
      cache = process.env.XDG_CACHE_HOME;
      process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cf-agent-mcp-"));
    });
    afterEach(() => {
      if (cache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = cache;
    });

    it("lives in the cache, is named funnel, and is shared by runs with the same shape", async () => {
      const servers = mcpServersFor(input("auto", { app: http }), ["http"]);
      const a = await attachMcp(servers);
      const b = await attachMcp(mcpServersFor(input("auto", { app: { ...http, url: "http://other/mcp" } as McpServer }), ["http"]));
      expect(a.dir.startsWith(process.env.XDG_CACHE_HOME!)).toBe(true);
      expect(a.dir.endsWith("/funnel")).toBe(true);
      expect(a.dir).toBe(b.dir);
      expect(readdirSync(a.dir).sort()).toEqual([".cursor-plugin", ".mcp.json"]);
      expect(JSON.parse(readFileSync(join(a.dir, ".cursor-plugin", "plugin.json"), "utf8")).name).toBe("funnel");
      expect(readFileSync(join(a.dir, ".mcp.json"), "utf8")).not.toContain("sekrit");
      const other = await attachMcp(mcpServersFor(input("auto", { renamed: http }), ["http"]));
      expect(other.dir).not.toBe(a.dir);
    });
  });

  it("adds --plugin-dir and nothing that widens access", () => {
    const args = buildArgs(input("auto", { app: http }), "m", "/w", ["/cache/funnel"]);
    expect(args).toEqual(expect.arrayContaining(["--plugin-dir", "/cache/funnel", "--auto-review"]));
    expect(args).not.toContain("--approve-mcps");
    expect(args.join(" ")).not.toContain("sekrit");
  });

  it("takes HTTP at auto and full, stdio at full, and nothing at none", () => {
    expect(agentProvider.capabilities.mcpServers).toEqual(["http", "stdio"]);
    expect(mcpServersFor(input("auto", { app: http }), ["http", "stdio"])).toHaveLength(1);
    expect(() => mcpServersFor(input("auto", { local: stdio }), ["http", "stdio"])).toThrow(/stdio MCP server is not allowed/);
    expect(() => mcpServersFor(input("none", { app: http }), ["http", "stdio"])).toThrow(/not allowed at access "none"/);
  });
});

describe.skipIf(process.platform === "win32")("run with a fake CLI", () => {
  let dir: string;
  let out: string;
  let cache: string | undefined;

  /** A stand-in `agent`. `status` answers with `statusJson`, and a run records what it was started with. */
  function fakeAgent(statusJson: string) {
    dir = mkdtempSync(join(tmpdir(), "cf-agent-fake-"));
    out = join(dir, "out");
    const bin = join(dir, "agent");
    writeFileSync(
      bin,
      `#!/bin/sh
case "$1" in
  status) echo '${statusJson}'; exit 0 ;;
  --list-models) exit 0 ;;
esac
echo "$@" > "${out}.args"
env | grep -E '^(CURSOR_API_KEY|AGENT_CLI_CREDENTIAL_STORE|CLI_FUNNEL_MCP_)' | sort > "${out}.env"
cat > /dev/null
echo '{"type":"system","subtype":"init","apiKeySource":"env","cwd":"/w","session_id":"s1"}'
echo '{"type":"result","subtype":"success","result":"ok","usage":{}}'
`,
    );
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGENT_BIN = bin;
  }

  beforeEach(() => {
    cache = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cf-agent-fake-cache-"));
  });
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGENT_BIN;
    if (cache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = cache;
  });

  const run = (extra: Partial<RunInput>): Promise<FunnelEvent[]> => {
    const input: RunInput = { selection: sel({ cwd: dir }), prompt: "hi", ...extra };
    return (async () => {
      const events: FunnelEvent[] = [];
      for await (const e of agentProvider.run(input)) events.push(e);
      return events;
    })();
  };

  it("refuses an API key when the memory store does not hide the saved login", async () => {
    fakeAgent('{"isAuthenticated": true}');
    await expect(run({ apiKey: "key_live_abc123" })).rejects.toThrow(/would save the API key over the saved login/);
    expect(existsSync(`${out}.args`)).toBe(false);
  });

  it("passes the key and the memory store in the environment, never in argv", async () => {
    fakeAgent('{"isAuthenticated": false}');
    const events = await run({ apiKey: "key_live_abc123" });
    expect(events[0]).toEqual({ type: "session", sessionId: "s1", auth: "api-key" });
    expect(readFileSync(`${out}.env`, "utf8")).toBe("AGENT_CLI_CREDENTIAL_STORE=memory\nCURSOR_API_KEY=key_live_abc123\n");
    expect(readFileSync(`${out}.args`, "utf8")).not.toContain("key_live_abc123");
    expect(readFileSync(`${out}.args`, "utf8")).not.toContain("--api-key");
  });

  it("leaves the environment alone without a key", async () => {
    fakeAgent('{"isAuthenticated": true}');
    const before = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      await run({});
      expect(readFileSync(`${out}.env`, "utf8")).toBe("");
    } finally {
      if (before !== undefined) process.env.CURSOR_API_KEY = before;
    }
  });

  it("starts the CLI with the MCP plugin and the server values in the environment", async () => {
    fakeAgent('{"isAuthenticated": false}');
    await run({ selection: sel({ cwd: dir, access: "auto" }), mcpServers: { app: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t0ken-value" } } } });
    const args = readFileSync(`${out}.args`, "utf8");
    const pluginDir = args.match(/--plugin-dir (\S+)/)![1]!;
    expect(JSON.parse(readFileSync(join(pluginDir, ".mcp.json"), "utf8")).mcpServers.app.headers.Authorization).toBe("${env:CLI_FUNNEL_MCP_0_H0}");
    expect(args).not.toContain("t0ken-value");
    expect(args).not.toContain("--approve-mcps");
    expect(readFileSync(`${out}.env`, "utf8")).toContain("CLI_FUNNEL_MCP_0_H0=Bearer t0ken-value");
  });

  it("cuts the key out of an error", async () => {
    fakeAgent('{"isAuthenticated": false}');
    const bin = process.env.CLI_FUNNEL_AGENT_BIN!;
    writeFileSync(bin, `#!/bin/sh\ncase "$1" in status) echo '{"isAuthenticated": false}'; exit 0;; --list-models) exit 0;; esac\ncat > /dev/null\necho '{"type":"result","subtype":"error","is_error":true,"result":"bad key key_live_abc123 rejected"}'\n`);
    const events = await run({ apiKey: "key_live_abc123" });
    expect(events.at(-1)).toEqual({ type: "error", message: "bad key [redacted] rejected" });
  });
});

const LIVE_KEY = process.env.CLI_FUNNEL_TEST_CURSOR_KEY;

describe.skipIf(!LIVE_KEY)("live API key", () => {
  it("runs on the key and leaves the saved login alone", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cf-agent-key-"));
    const selection = sel({ cwd });
    const authFile = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? "", ".config"), "cursor", "auth.json");
    const before = existsSync(authFile) ? readFileSync(authFile, "utf8") : undefined;
    const input = { selection, prompt: "Reply with the single word ok.", apiKey: LIVE_KEY };
    const res = await collect(agentProvider.run(input), input);
    expect(res.auth).toBe("api-key");
    expect(res.text.length).toBeGreaterThan(0);
    expect(existsSync(authFile) ? readFileSync(authFile, "utf8") : undefined).toBe(before);
  }, 120_000);
});
