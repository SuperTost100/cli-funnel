import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planAccess } from "../src/providers/codex/access.js";
import { toApprovalRequest, toReply } from "../src/providers/codex/approvals.js";
import { parseLoginStatus } from "../src/providers/codex/auth.js";
import { type ForwardSubagents, Translator } from "../src/providers/codex/events.js";
import { codexProvider, INITIALIZE_PARAMS } from "../src/providers/codex/index.js";
import { parseCatalog } from "../src/providers/codex/models.js";
import { configServers, declaredServers, noToolsConfig } from "../src/providers/codex/tools.js";
import { collect } from "./helpers.js";
import type { FunnelEvent } from "../src/types.js";

const fx = (name: string) => new URL(`./fixtures/codex/${name}`, import.meta.url);
const load = (name: string) =>
  readFileSync(fx(name), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { dir: string; m: any });

function replay(name: string, forward: ForwardSubagents = {}) {
  const rows = load(name);
  const thread = rows.find((r) => r.m.result?.thread)!.m.result.thread.id;
  const t = new Translator(thread, "/tmp/cf-codex-test", forward);
  const events: FunnelEvent[] = [];
  const requests: any[] = [];
  for (const { dir, m } of rows) {
    if (dir !== "in" || !m.method) continue;
    if (m.id !== undefined) requests.push(m);
    else events.push(...t.handle(m.method, m.params).events);
  }
  return { events, requests, t };
}

describe("codex events", () => {
  it("translates a plain reply", () => {
    const { events } = replay("hello.ndjson");
    expect(events.filter((e) => e.type === "text.delta").length).toBeGreaterThan(0);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", finishReason: "stop" });
    expect(events.find((e) => e.type === "usage")).toBeTruthy();
  });

  it("emits tool events for a command", () => {
    const { events } = replay("approve-command.ndjson");
    const start = events.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ name: "command", input: { command: "/bin/zsh -lc 'echo hi > a.txt'" } });
    expect(events.find((e) => e.type === "tool.end")).toMatchObject({ error: undefined });
  });

  it("sums per-call usage over the turn", () => {
    const { events } = replay("approve-command.ndjson");
    const usage = events.filter((e) => e.type === "usage").at(-1) as Extract<FunnelEvent, { type: "usage" }>;
    expect(usage.usage.totalTokens).toBe(19245 + 19273);
  });

  it("streams commentary as text but keeps it out of the final text", () => {
    const { events } = replay("commentary.ndjson");
    const done = events.at(-1) as Extract<FunnelEvent, { type: "done" }>;
    expect(done.text).toBe('{"ok":true}');
    const streamed = events.filter((e) => e.type === "text.delta").map((e) => (e as { text: string }).text);
    expect(streamed).toEqual(["Let me ", "think.", '{"ok":', "true}"]);
    expect(events.some((e) => e.type === "reasoning.delta")).toBe(false);
  });

  it("still sends real reasoning as reasoning.delta", () => {
    const t = new Translator("a");
    expect(t.handle("item/reasoning/summaryTextDelta", { threadId: "a", itemId: "r", delta: "hmm" }).events).toEqual([{ type: "reasoning.delta", text: "hmm" }]);
  });

  it("treats a message without a phase as answer text", () => {
    const t = new Translator("a");
    t.handle("item/started", { threadId: "a", item: { type: "agentMessage", id: "m", text: "", phase: null } });
    expect(t.handle("item/agentMessage/delta", { threadId: "a", itemId: "m", delta: "hi" }).events).toEqual([{ type: "text.delta", text: "hi" }]);
    t.handle("item/completed", { threadId: "a", item: { type: "agentMessage", id: "m", text: "hi" } });
    expect(t.handle("turn/completed", { threadId: "a", turn: { status: "completed" } }).events[0]).toMatchObject({ type: "done", text: "hi" });
  });

  it("emits tool events for a web search", () => {
    const { events } = replay("web-search.ndjson");
    expect(events.find((e) => e.type === "tool.start")).toMatchObject({ id: "ws_1", name: "web_search" });
    expect(events.find((e) => e.type === "tool.end")).toMatchObject({ id: "ws_1" });
  });

  it("emits tool events for an image view", () => {
    const { events } = replay("image-view.ndjson");
    expect(events.find((e) => e.type === "tool.start")).toMatchObject({ id: "iv_1", name: "image_view", input: { path: "/tmp/cf-codex-test/chart.png" } });
    expect(events.find((e) => e.type === "tool.end")).toMatchObject({ id: "iv_1" });
  });

  it("emits tool events for a sub-agent call and reports a failed one", () => {
    const { events } = replay("sub-agent.ndjson");
    expect(events.find((e) => e.type === "tool.start")).toMatchObject({ id: "ca_1", name: "agent:spawnAgent", input: { prompt: "List the files in src." } });
    expect(events.find((e) => e.type === "tool.end")).toMatchObject({ id: "ca_1" });
    const t = new Translator("a");
    expect(t.handle("item/completed", { threadId: "a", item: { type: "collabAgentToolCall", id: "x", status: "failed" } }).events[0]).toMatchObject({ type: "tool.end", error: "Agent call failed" });
  });

  // Recorded from codex 0.166 with one spawned subagent that runs `ls`. Paths are replaced.
  describe("subagents on 0.166", () => {
    const SPAWN = "call_e81d997ed3134b7e90032bb9f83072a7";

    it("shows the spawn as a tool call, and nothing from the subagent's thread by default", () => {
      const { events } = replay("sub-agent-0.166.ndjson");
      expect(events.filter((e) => e.type === "tool.start").map((e) => (e as { name: string }).name)).toEqual(["agent:spawnAgent", "agent:wait"]);
      expect(events.find((e) => e.type === "tool.start")).toMatchObject({ id: SPAWN, input: { agent: "/root/list_files", model: "gpt-6-luna" } });
      expect(events.filter((e) => e.type === "tool.end").map((e) => (e as { id: string }).id)).toContain(SPAWN);
      expect(events.some((e) => "parentId" in e)).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "done" });
    });

    it("forwards the subagent's tool calls and messages with the spawn's id", () => {
      const { events } = replay("sub-agent-0.166.ndjson", { text: true, tools: true });
      const sub = events.filter((e) => "parentId" in e);
      expect(sub.map((e) => e.type)).toEqual(["tool.start", "tool.end", "subagent.text"]);
      expect(sub[0]).toMatchObject({ name: "command", input: { command: "/bin/bash -lc ls" }, parentId: SPAWN, agent: "list_files" });
      expect(sub[1]).toMatchObject({ type: "tool.end", id: (sub[0] as { id: string }).id, parentId: SPAWN, agent: "list_files" });
      expect(sub[2]).toEqual({ type: "subagent.text", parentId: SPAWN, agent: "list_files", text: "Files in the current directory: `a.txt`, `b.txt`." });
      // The main thread reads as before: the subagent's turn does not end it, and its text is not the answer.
      expect(events.filter((e) => !("parentId" in e))).toEqual(replay("sub-agent-0.166.ndjson").events);
      expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    });

    it("keeps a subagent's file changes out of the run", () => {
      const t = new Translator("main", "/w", { tools: true });
      t.handle("item/started", { threadId: "main", item: { type: "subAgentActivity", kind: "started", id: "spawn", agentThreadId: "child", agentPath: "/root/writer" } });
      const item = { type: "fileChange", id: "fc", status: "completed", changes: [{ path: "a.txt", kind: { type: "add" } }] };
      const events = [...t.handle("item/started", { threadId: "child", item: { ...item, status: "inProgress" } }).events, ...t.handle("item/completed", { threadId: "child", item }).events];
      expect(events.map((e) => e.type)).toEqual(["tool.start", "tool.end"]);
      expect(t.handle("turn/completed", { threadId: "child", turn: { status: "completed" } })).toEqual({ events: [] });
    });

    it("follows a subagent's own subagents with text forwarding alone", () => {
      const t = new Translator("main", "/w", { text: true });
      const spawn = (thread: string, id: string, child: string) =>
        t.handle("item/started", { threadId: thread, item: { type: "subAgentActivity", kind: "started", id, agentThreadId: child, agentPath: `/root/${child}` } });
      spawn("main", "s1", "child");
      spawn("child", "s2", "grandchild");
      // An older Codex names the new thread only when the spawnAgent call completes.
      t.handle("item/completed", { threadId: "child", item: { type: "collabAgentToolCall", tool: "spawnAgent", id: "s3", status: "completed", receiverThreadIds: ["old"] } });
      const said = (thread: string) => t.handle("item/completed", { threadId: thread, item: { type: "agentMessage", id: "m", text: "hi" } }).events;
      expect(said("grandchild")).toEqual([{ type: "subagent.text", parentId: "s2", text: "hi", agent: "grandchild" }]);
      expect(said("old")).toEqual([{ type: "subagent.text", parentId: "s3", text: "hi" }]);
    });

    it("maps the threads of an older spawnAgent call", () => {
      const t = new Translator("main", "/w", { tools: true });
      t.handle("item/completed", { threadId: "main", item: { type: "collabAgentToolCall", tool: "spawnAgent", id: "ca", status: "completed", receiverThreadIds: ["child"] } });
      expect(t.handle("item/started", { threadId: "child", item: { type: "commandExecution", id: "c1", command: "ls" } }).events).toEqual([
        { type: "tool.start", id: "c1", name: "command", input: { command: "ls", cwd: undefined }, parentId: "ca" },
      ]);
    });
  });

  it("ignores other threads", () => {
    const t = new Translator("a");
    expect(t.handle("item/agentMessage/delta", { threadId: "b", delta: "x" }).events).toEqual([]);
  });

  it("reports failed and interrupted turns", () => {
    const t = new Translator("a");
    expect(t.handle("turn/completed", { threadId: "a", turn: { status: "failed", error: { message: "boom" } } }).events[0]).toEqual({ type: "error", message: "boom" });
    expect(t.handle("turn/completed", { threadId: "a", turn: { status: "interrupted" } }).events[0]).toMatchObject({ finishReason: "cancelled" });
  });
});

describe("codex approvals", () => {
  it("maps a command approval and both decisions", () => {
    const { requests, t } = replay("approve-command.ndjson");
    const req = requests[0];
    const a = toApprovalRequest(req, t)!;
    expect(a.tool).toBe("command");
    expect(a.input).toMatchObject({ command: "/bin/zsh -lc 'echo hi > a.txt'" });
    expect(toReply(req, "allow")).toEqual({ result: { decision: "accept" } });
    expect(toReply(req, "deny")).toEqual({ result: { decision: "decline" } });
  });

  it("maps a file change approval using the item's changes", () => {
    const { requests, t } = replay("approve-file-change.ndjson");
    const a = toApprovalRequest(requests[0], t)!;
    expect(a.tool).toBe("file_change");
    expect((a.input as any).changes[0].path).toContain("b.txt");
  });

  it("rejects unknown server requests", () => {
    const req = { id: 1, method: "item/tool/call", params: {} };
    expect(toApprovalRequest(req, { items: new Map(), mcpCalls: new Map() })).toBeUndefined();
    expect(toReply(req, "allow")).toHaveProperty("error");
  });
});

describe("codex access plan", () => {
  it("maps each level", () => {
    expect(planAccess("supervised")).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write", autoAllowFileChanges: false });
    expect(planAccess("accept-edits")).toMatchObject({ approvalPolicy: "untrusted", autoAllowFileChanges: true });
    expect(planAccess("auto")).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
    expect(planAccess("full")).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });
});

describe("codex initialize", () => {
  it("sends the package version as clientInfo.version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(INITIALIZE_PARAMS.clientInfo.version).toBe(pkg.version);
  });
});

describe("codex models and auth", () => {
  it("parses the catalog and skips hidden models", () => {
    const models = parseCatalog(readFileSync(fx("models.json"), "utf8"));
    expect(models.map((m) => m.id)).toContain("gpt-6-luna");
    expect(models.map((m) => m.id)).not.toContain("gpt-reserve");
    const luna = models.find((m) => m.id === "gpt-6-luna")!;
    expect(luna.fast).toBe(true);
    expect(luna.defaultEffort).toBe("medium");
    expect(luna.efforts.map((e) => e.id)).toContain("xhigh");
  });

  it("parses login status", () => {
    expect(parseLoginStatus("Logged in using ChatGPT\n")).toMatchObject({ loggedIn: true, method: "ChatGPT" });
    expect(parseLoginStatus("Logged in using an API key - sk-abc***")).toMatchObject({ loggedIn: true, method: "API key", detail: "Logged in using an API key" });
    expect(parseLoginStatus("Not logged in")).toMatchObject({ loggedIn: false });
  });
});

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1")("codex live", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-codex-live-"));
  const selection = { provider: "codex" as const, model: "gpt-6-luna", effort: "low", cwd, access: "supervised" as const };

  it("answers a tiny prompt", async () => {
    const input = { selection: { ...selection, access: "full" as const }, prompt: "say hi" };
    const res = await collect(codexProvider.run(input), input);
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.sessionId).toBeTruthy();
  }, 90_000);

  it("asks before running a command and honors deny", async () => {
    const asked: string[] = [];
    const input = {
      selection,
      prompt: "Run the shell command: echo hi > a.txt . Then reply done.",
      onApproval: (r: { tool: string }) => {
        asked.push(r.tool);
        return "deny" as const;
      },
    };
    await collect(codexProvider.run(input), input);
    expect(asked).toContain("command");
    expect(() => readFileSync(join(cwd, "a.txt"))).toThrow();
  }, 120_000);
});

describe("codex none: configured MCP servers", () => {
  it("finds servers in every TOML spelling", () => {
    const text = [
      "[mcp_servers.bare]",
      'command = "x"',
      '[mcp_servers."double"]',
      "[mcp_servers.'single']",
      "[ mcp_servers . 'spaced' ]",
      "[mcp_servers.withenv.env]",
      'mcp_servers.dotted.command = "x"',
    ].join("\n");
    const names = ["bare", "double", "single", "spaced", "withenv", "dotted", "plugin-added"];
    expect(declaredServers(text, names)).toEqual(names.slice(0, -1));
  });

  it("finds servers in an inline table and under a [mcp_servers] table", () => {
    expect(declaredServers(`mcp_servers = { probe = { command = "x" }, 'two' = { command = "y" } }`, ["probe", "two", "three"])).toEqual(["probe", "two"]);
    expect(declaredServers(`[mcp_servers]\nother = { command = "x" }\n"quoted x".command = "y"`, ["other", "quoted x", "nope"])).toEqual(["other", "quoted x"]);
  });

  it("does not take keys outside mcp_servers for servers", () => {
    expect(declaredServers(`[profiles.probe]\nmodel = "x"\n[tools]\nprobe = true`, ["probe"])).toEqual([]);
  });

  it("lists the servers of config/read and refuses an answer without the table", () => {
    // The shape codex 0.166 answers for a config.toml with "mcp_servers".quoted.command and "mcp_servers"."esc\u0061ped".command.
    const res = { config: { model: null, mcp_servers: { quoted: { command: "echo", enabled: true }, escaped: { command: "echo", enabled: true } } }, origins: {} };
    expect(configServers(res)).toEqual(["quoted", "escaped"]);
    expect(configServers({ config: { mcp_servers: {} } })).toEqual([]);
    for (const bad of [undefined, null, {}, { config: {} }, { config: { mcp_servers: null } }, { config: { mcp_servers: ["a"] } }]) {
      expect(() => configServers(bad)).toThrow(/mcp_servers/);
    }
  });

  it("switches the servers off in a nested table, so a dotted name stays one server", () => {
    const config = noToolsConfig(["a.b", "plain"]);
    expect(config.mcp_servers).toEqual({ "a.b": { enabled: false }, plain: { enabled: false } });
    expect(Object.keys(config).some((k) => k.startsWith("mcp_servers."))).toBe(false);
    expect(noToolsConfig([])).not.toHaveProperty("mcp_servers");
  });
});
