import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fakeNodeCli } from "./fake-cli.js";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { denyNote, effectiveReply, isQuestion, toApprovalRequest, toQuestionReply, toQuestionRequest, toReply } from "../src/providers/codex/approvals.js";
import { startedAccess } from "../src/providers/codex/access.js";
import { authKind } from "../src/providers/codex/auth.js";
import { fileChangeEvents, planEvent, Translator, warningText } from "../src/providers/codex/events.js";
import { codexProvider } from "../src/providers/codex/index.js";
import { appServerArgs } from "../src/providers/codex/live.js";
import { agentConfig, mcpConfig } from "../src/providers/codex/options.js";
import { collect } from "./helpers.js";
import type { AccessLevel, FunnelEvent, McpServer, RunInput } from "../src/types.js";

// Fixtures recorded from codex-cli 0.164.0 app-server runs, with home paths, machine names and account data replaced.
const load = (name: string) =>
  readFileSync(new URL(`./fixtures/codex/${name}`, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { dir: string; m: any });

/** Feeds the recorded notifications to a translator. Server requests are collected, and each is checked as it arrives. */
function replay(name: string, onRequest?: (m: any, t: Translator) => void) {
  const rows = load(name);
  const start = rows.find((r) => r.m.result?.thread)!.m.result;
  const t = new Translator(start.thread.id, start.cwd);
  const events: FunnelEvent[] = [];
  const requests: any[] = [];
  const out: any[] = [];
  for (const { dir, m } of rows) {
    if (dir === "out") out.push(m);
    if (dir !== "in" || !m.method) continue;
    if (m.id !== undefined) {
      requests.push(m);
      onRequest?.(m, t);
    } else events.push(...t.handle(m.method, m.params).events);
  }
  return { events, requests, out, t };
}

// configWarning summaries as codex-cli 0.166.0 sent them under a requirements file.
const SANDBOX_WARNING =
  "Configured value for `permission_profile` is disallowed by requirements; falling back to required value Managed { file_system: Restricted { entries: [FileSystemSandboxEntry { path: Special { value: Root }, access: Read, missing_path_behavior: None }], glob_scan_max_depth: None }, network: Restricted }. Details: invalid value for `sandbox_mode`: `WorkspaceWrite` is not in the allowed set [ReadOnly] (set by /etc/codex/requirements.toml)";
const BUBBLEWRAP_WARNING = "Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. Codex will use the bundled bubblewrap in the meantime.";
const APPROVAL_WARNING =
  "Configured value for `approval_policy` is disallowed by requirements; falling back to required value Never. Details: invalid value for `approval_policy`: `UnlessTrusted` is not in the allowed set [Never] (set by /etc/codex/requirements.toml)";

const input = (access: AccessLevel, extra: Partial<RunInput> = {}): RunInput => ({ selection: { provider: "codex", model: "m", cwd: "/tmp", access }, prompt: "x", ...extra });
const http = (extra: Partial<McpServer> = {}): McpServer => ({ type: "http", url: "http://127.0.0.1:7777/mcp", ...extra }) as McpServer;

describe("codex started access", () => {
  const asked = { sandbox: "workspace-write", approvalPolicy: "untrusted" } as const;
  const answer = (type: string, approvalPolicy = "untrusted") => ({ sandbox: { type }, approvalPolicy });

  it("reports a narrower sandbox with the warnings that name the sandbox, and without a reason when there are none", () => {
    expect(startedAccess("accept-edits", asked, answer("readOnly"), [BUBBLEWRAP_WARNING, SANDBOX_WARNING])).toEqual({
      access: "accept-edits",
      expected: "workspace-write",
      started: "read-only",
      reason: SANDBOX_WARNING,
    });
    expect(startedAccess("accept-edits", asked, answer("readOnly"), [BUBBLEWRAP_WARNING])).toEqual({ access: "accept-edits", expected: "workspace-write", started: "read-only" });
  });

  it("reports nothing for the sandbox that was asked for, a wider one, or a type it does not know", () => {
    expect(startedAccess("supervised", asked, answer("workspaceWrite"), [])).toBeUndefined();
    expect(startedAccess("supervised", asked, answer("dangerFullAccess"), [])).toBeUndefined();
    expect(startedAccess("supervised", asked, answer("externalSandbox"), [SANDBOX_WARNING])).toBeUndefined();
    expect(startedAccess("supervised", asked, {}, [])).toBeUndefined();
  });

  it("compares with what was sent: full with sandbox asks for workspace-write and gets it", () => {
    const sent = { sandbox: "workspace-write", approvalPolicy: "never" } as const;
    expect(startedAccess("full", sent, answer("workspaceWrite", "never"), [])).toBeUndefined();
    expect(startedAccess("full", { ...sent, sandbox: "danger-full-access" }, answer("workspaceWrite", "never"), [])).toMatchObject({ expected: "danger-full-access", started: "workspace-write" });
  });

  it("throws cli-failed when the policy asks less often than the level needs, and quotes the warning", () => {
    expect(() => startedAccess("supervised", asked, answer("workspaceWrite", "never"), [APPROVAL_WARNING])).toThrow(
      expect.objectContaining({ code: "cli-failed", message: expect.stringContaining(APPROVAL_WARNING) }),
    );
    expect(() => startedAccess("supervised", asked, answer("workspaceWrite", "on-request"), [])).toThrow(/"on-request".*"untrusted"/);
  });

  it("accepts a policy that asks more often, and ignores a missing or unknown one", () => {
    const auto = { sandbox: "workspace-write", approvalPolicy: "on-request" } as const;
    expect(startedAccess("auto", auto, answer("workspaceWrite", "untrusted"), [])).toBeUndefined();
    expect(startedAccess("auto", auto, { sandbox: { type: "workspaceWrite" } }, [])).toBeUndefined();
    expect(startedAccess("auto", auto, answer("workspaceWrite", "granular"), [])).toBeUndefined();
  });
});

describe("codex warning text", () => {
  it("joins the summary and the details of configWarning and deprecationNotice", () => {
    expect(warningText("configWarning", { summary: "Codex could not find bubblewrap on PATH.", details: null })).toBe("Codex could not find bubblewrap on PATH.");
    expect(warningText("configWarning", { summary: "Bad value.", details: "" })).toBe("Bad value.");
    expect(warningText("deprecationNotice", { summary: "`foo` is deprecated.", details: "Use `bar`." })).toBe("`foo` is deprecated. Use `bar`.");
  });

  it("takes the message of warning and guardianWarning, with or without a thread", () => {
    expect(warningText("warning", { threadId: "t", message: "Falling back." })).toBe("Falling back.");
    expect(warningText("warning", { threadId: null, message: "Falling back." })).toBe("Falling back.");
    expect(warningText("guardianWarning", { threadId: "t", message: "Paused." })).toBe("Paused.");
  });

  it("gives nothing for another method or a notification without text", () => {
    expect(warningText("error", { message: "x" })).toBeUndefined();
    expect(warningText("item/started", { summary: "x" })).toBeUndefined();
    expect(warningText("configWarning", { details: "x" })).toBeUndefined();
    expect(warningText("warning", { threadId: "t", message: "" })).toBeUndefined();
    expect(warningText("warning", undefined)).toBeUndefined();
  });
});

describe("codex plans", () => {
  it("emits the whole plan on each turn/plan/updated, with mapped statuses", () => {
    const plans = replay("plan-file-changes.ndjson").events.filter((e) => e.type === "plan");
    expect(plans).toHaveLength(4);
    expect(plans[0]).toEqual({
      type: "plan",
      steps: [
        { text: "Create a.txt containing one", status: "in_progress" },
        { text: "Rename b.txt to c.txt and change its text to sea", status: "pending" },
        { text: "Delete d.txt", status: "pending" },
      ],
    });
    expect((plans.at(-1) as any).steps.map((s: any) => s.status)).toEqual(["done", "done", "done"]);
  });

  it("keeps the explanation and treats an unknown status as pending", () => {
    expect(planEvent({ explanation: "why", plan: [{ step: "a", status: "later" }] })).toEqual({ type: "plan", steps: [{ text: "a", status: "pending" }], explanation: "why" });
    expect(planEvent({ explanation: null, plan: null })).toEqual({ type: "plan", steps: [] });
  });
});

describe("codex file changes", () => {
  it("emits one file.change per entry once the item completes, before its tool.end", () => {
    const { events } = replay("plan-file-changes.ndjson");
    const changes = events.filter((e) => e.type === "file.change");
    const root = "/tmp/cf-codex-plan-d3oJjg";
    expect(changes).toEqual([
      { type: "file.change", id: "exec-e0d24b47-e6b1-45cc-be48-934ac852580b", path: `${root}/a.txt`, kind: "add", status: "done" },
      { type: "file.change", id: "exec-7aa14608-12ae-4aeb-9f97-1e8584133c50", path: `${root}/b.txt`, kind: "update", movedTo: `${root}/c.txt`, status: "done" },
      { type: "file.change", id: "exec-f4f8b7b3-3a97-4f17-8f39-5469c7809842", path: `${root}/d.txt`, kind: "delete", status: "done" },
    ]);
    for (const c of changes) {
      const i = events.indexOf(c);
      expect(events.findIndex((e, j) => j > i && e.type === "tool.end" && e.id === (c as any).id)).toBeGreaterThan(i);
    }
    // The run also ran `rm e.txt` in the shell. Codex reports it as a command with an "unknown" action, not a change.
    expect(changes.some((c) => (c as any).path.endsWith("e.txt"))).toBe(false);
  });

  it("reports a declined change", () => {
    const changes = replay("deny-file-with-message.ndjson").events.filter((e) => e.type === "file.change");
    expect(changes).toEqual([{ type: "file.change", id: "exec-280d14b2-8795-4b23-b7da-78e97bf2f633", path: "/tmp/cf-codex-deny-f2uz6T/x.txt", kind: "add", status: "declined" }]);
  });

  it("resolves relative paths against the thread cwd and skips unfinished items", () => {
    const item = { id: "i", status: "failed", changes: [{ path: "src/a.ts", kind: { type: "update", move_path: "src/b.ts" } }, { path: "x", kind: { type: "weird" } }] };
    expect(fileChangeEvents(item, "/w")).toEqual([{ type: "file.change", id: "i", path: resolve("/w", "src/a.ts"), kind: "update", movedTo: resolve("/w", "src/b.ts"), status: "failed" }]);
    expect(fileChangeEvents({ ...item, status: "inProgress" }, "/w")).toEqual([]);
  });
});

describe("codex questions", () => {
  it("round-trips the recorded question: three options each, one chosen label and one free-text answer", () => {
    const { requests, out } = replay("question.ndjson");
    const req = { id: requests[0].id, method: requests[0].method, params: requests[0].params };
    expect(isQuestion(req)).toBe(true);
    const q = toQuestionRequest(req);
    expect(q.id).toBe("call_46a2f096905142cc84d370d367cd9c78");
    expect(q.questions[0]).toEqual({
      id: "favourite_colour",
      header: "Colour",
      question: "Which is your favourite colour?",
      options: [
        { label: "Red", description: "Select red." },
        { label: "Green", description: "Select green." },
        { label: "Blue", description: "Select blue." },
      ],
      allowOther: true,
    });
    expect(q.questions[1]!.options).toHaveLength(3);
    const reply = toQuestionReply(req, { favourite_colour: ["Blue"], favourite_animal: ["a red panda"] }) as { result: any };
    expect(reply.result.answers).toEqual({ favourite_colour: { answers: ["Blue"] }, favourite_animal: { answers: ["user_note: a red panda"] } });
    // The recorded run sent the same shape and the model repeated both answers.
    const sent = out.find((m) => m.id === requests[0].id && m.result);
    expect(sent.result.answers.favourite_colour).toEqual(reply.result.answers.favourite_colour);
    expect(sent.result.answers.favourite_animal.answers).toContain("user_note: a red panda");
  });

  it("declines with no answers and skips unanswered questions", () => {
    const req = { id: 1, method: "item/tool/requestUserInput", params: { itemId: "c", questions: [{ id: "a", question: "?", isOther: false, isSecret: true, options: null }] } };
    expect(toQuestionReply(req, null)).toEqual({ result: { answers: {} } });
    expect(toQuestionReply(req, {})).toEqual({ result: { answers: {} } });
    expect(toQuestionRequest(req).questions[0]).toEqual({ id: "a", question: "?", options: [], secret: true });
  });
});

describe("codex approvals with a message", () => {
  it("names the MCP tool an elicitation approval is about", () => {
    let seen: any;
    replay("mcp-approval.ndjson", (m, t) => (seen = toApprovalRequest({ id: m.id, method: m.method, params: m.params }, t)));
    expect(seen).toEqual({ id: "0", tool: "mcp:cftest/lucky_number", input: {}, description: 'Allow the cftest MCP server to run tool "lucky_number"?' });
  });

  it("turns an allow with updatedInput into a deny, and only a deny with a message gets a note", () => {
    expect(effectiveReply({ decision: "allow", updatedInput: { a: 1 } })).toEqual({ decision: "deny" });
    expect(effectiveReply({ decision: "allow", updatedInput: {}, message: "m" })).toEqual({ decision: "deny", message: "m" });
    expect(effectiveReply("allow")).toEqual({ decision: "allow" });
    expect(denyNote({ decision: "deny", message: "Not here." })).toBe("The user denied that action and said: Not here.");
    expect(denyNote({ decision: "deny" })).toBeUndefined();
    expect(denyNote({ decision: "allow", message: "ok" })).toBeUndefined();
    const req = { id: 1, method: "item/fileChange/requestApproval", params: {} };
    expect(toReply(req, { decision: "allow", updatedInput: {} })).toEqual({ result: { decision: "decline" } });
  });

  it("answers an MCP approval that Codex routes through request_user_input", () => {
    const req = { id: 2, method: "item/tool/requestUserInput", params: { itemId: "call-1", questions: [{ id: "mcp_tool_call_approval_call-1", question: "Allow?", options: [] }] } };
    expect(isQuestion(req)).toBe(false);
    const ctx = { items: new Map(), mcpCalls: new Map([["call-1", { id: "call-1", thread: "thr", server: "srv", tool: "t", arguments: { q: 1 } }]]) };
    expect(toApprovalRequest(req, ctx)).toEqual({ id: "call-1", tool: "mcp:srv/t", input: { q: 1 }, description: "Allow?" });
    expect(toReply(req, "allow")).toEqual({ result: { answers: { "mcp_tool_call_approval_call-1": { answers: ["Allow"] } } } });
    expect(toReply(req, "deny")).toEqual({ result: { answers: { "mcp_tool_call_approval_call-1": { answers: ["Cancel"] } } } });
  });
});

describe("codex MCP approvals with calls in flight", () => {
  const call = (id: string, tool: string, args: unknown) => [id, { id, thread: "main", server: "srv", tool, arguments: args }] as const;
  const elicit = (params: unknown) => ({
    id: 9,
    method: "mcpServer/elicitation/request",
    params: { threadId: "main", serverName: "srv", message: "Allow?", _meta: { codex_approval_kind: "mcp_tool_call", tool_params: params } },
  });

  it("matches the elicitation to the call with the same arguments", () => {
    const ctx = { items: new Map(), mcpCalls: new Map([call("a", "read", { q: 1 }), call("b", "write", { q: 2 })]) };
    expect(toApprovalRequest(elicit({ q: 1 }), ctx)).toMatchObject({ tool: "mcp:srv/read", input: { q: 1 } });
    expect(toApprovalRequest(elicit({ q: 2 }), ctx)).toMatchObject({ tool: "mcp:srv/write", input: { q: 2 } });
    const keyed = { items: new Map(), mcpCalls: new Map([call("a", "read", { a: 1, b: 2 }), call("b", "write", { q: 2 })]) };
    expect(toApprovalRequest(elicit({ b: 2, a: 1 }), keyed)).toMatchObject({ tool: "mcp:srv/read" });
  });

  it("falls back to the generic mcp tool when no single call matches", () => {
    const ctx = { items: new Map(), mcpCalls: new Map([call("a", "read", { q: 1 }), call("b", "write", { q: 1 })]) };
    expect(toApprovalRequest(elicit({ q: 1 }), ctx)).toMatchObject({ tool: "mcp", input: { q: 1 } });
  });

  it("does not take the identity of a sole call whose arguments differ", () => {
    const ctx = { items: new Map(), mcpCalls: new Map([call("a", "read", { q: 1 })]) };
    expect(toApprovalRequest(elicit({ path: "/etc" }), ctx)).toMatchObject({ tool: "mcp", input: { path: "/etc" } });
  });

  it("binds a subagent's elicitation to the subagent's call when tool events are not forwarded", () => {
    const t = new Translator("main");
    const started = (threadId: string, id: string, tool: string, args: unknown) =>
      t.handle("item/started", { threadId, item: { type: "mcpToolCall", id, server: "srv", tool, arguments: args } });
    const spawn = { type: "subAgentActivity", kind: "started", id: "spawn-1", agentThreadId: "child", agentPath: "/root/helper" };
    t.handle("item/started", { threadId: "main", item: spawn });
    started("main", "m1", "read", { q: 1 });
    started("child", "c1", "delete", { path: "/etc" });
    const fromChild = { ...elicit({ path: "/etc" }), params: { ...elicit({ path: "/etc" }).params, threadId: "child" } };
    expect(toApprovalRequest(fromChild, t)).toMatchObject({ tool: "mcp:srv/delete", input: { path: "/etc" } });
    // Same arguments on another thread: the main thread's elicitation names its own call only.
    started("child", "c2", "read", { q: 1 });
    expect(toApprovalRequest(elicit({ q: 1 }), t)).toMatchObject({ tool: "mcp:srv/read" });
    t.handle("item/completed", { threadId: "main", item: { type: "mcpToolCall", id: "m1", status: "completed" } });
    expect(toApprovalRequest(elicit({ q: 1 }), t)).toMatchObject({ tool: "mcp" });
  });

  it("does not retain calls from threads that are not this run's subagents", () => {
    const t = new Translator("main");
    t.handle("item/started", { threadId: "stranger", item: { type: "mcpToolCall", id: "x", server: "srv", tool: "t", arguments: {} } });
    expect(t.mcpCalls.size).toBe(0);
  });
});

describe("codex MCP servers and feature config", () => {
  it("maps HTTP and stdio servers to mcp_servers keys", () => {
    const servers = {
      app: http({ headers: { Authorization: "Bearer t" }, toolTimeoutSec: 900, autoApprove: true }),
      plain: http(),
      local: { type: "stdio", command: "node", args: ["s.js"], env: { A: "1" }, toolTimeoutSec: 5 } as McpServer,
    };
    expect(mcpConfig(input("full", { mcpServers: servers }))).toEqual({
      "mcp_servers.app.url": "http://127.0.0.1:7777/mcp",
      "mcp_servers.app.http_headers": { Authorization: "Bearer t" },
      "mcp_servers.app.default_tools_approval_mode": "approve",
      "mcp_servers.app.tool_timeout_sec": 900,
      "mcp_servers.plain.url": "http://127.0.0.1:7777/mcp",
      "mcp_servers.local.command": "node",
      "mcp_servers.local.args": ["s.js"],
      "mcp_servers.local.env": { A: "1" },
      "mcp_servers.local.tool_timeout_sec": 5,
    });
  });

  it("refuses servers at none and stdio below full", () => {
    expect(() => mcpConfig(input("none", { mcpServers: { a: http() } }))).toThrow(/not allowed/);
    expect(() => mcpConfig(input("supervised", { mcpServers: { a: { type: "stdio", command: "x" } } }))).toThrow(/not allowed/);
    expect(mcpConfig(input("supervised", { mcpServers: { a: http() } }))).toEqual({ "mcp_servers.a.url": "http://127.0.0.1:7777/mcp" });
  });

  it("switches plans on with planTool below none, and questions on with onQuestion", () => {
    expect(agentConfig(input("supervised"))).toEqual({});
    expect(agentConfig(input("supervised", { planTool: true }))).toEqual({ "tools.update_plan.enabled": true });
    expect(agentConfig(input("none", { planTool: true }))).toEqual({});
    expect(agentConfig(input("none", { onQuestion: () => null }))).toEqual({ "features.default_mode_request_user_input": true });
  });

});

describe("codex API key and auth", () => {
  it("keeps credentials in memory only when an API key is passed", () => {
    expect(appServerArgs(input("auto", { apiKey: "sk-x" }))).toEqual(["app-server", "-c", 'cli_auth_credentials_store="ephemeral"']);
    expect(appServerArgs(input("auto"))).toEqual(["app-server"]);
  });

  it("reads only the account type", () => {
    expect(authKind({ account: { type: "chatgpt", email: null, planType: "plus" } })).toBe("account");
    expect(authKind({ account: { type: "apiKey" } })).toBe("api-key");
    expect(authKind({ account: null })).toBeUndefined();
    expect(authKind({ account: { type: "amazonBedrock" } })).toBeUndefined();
  });
});

// A fake `codex app-server` for the wiring: it logs what it receives and acts out one scenario per prompt.
const FAKE = `const fs = require("node:fs");
const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\\n");
log({ args: process.argv.slice(2) });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const thread = "thr-1";
let turn;
let prompt;
const done = (text) => {
  send({ method: "item/completed", params: { threadId: thread, item: { type: "agentMessage", text } } });
  send({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "completed" } } });
};
const question = ${JSON.stringify(load("question.ndjson").find((r) => r.m.method === "item/tool/requestUserInput")!.m.params)};
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    log(m);
    if (m.id === "srv-1") { done(JSON.stringify(m.result)); continue; }
    const p = m.params || {};
    switch (m.method) {
      case "initialize": send({ id: m.id, result: {} }); break;
      case "account/login/start": send({ id: m.id, result: { type: "apiKey" } }); break;
      case "account/read": send({ id: m.id, result: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true } }); break;
      case "config/read":
        if (process.env.FAKE_MCP === "error") send({ id: m.id, error: { code: -32601, message: "unknown method" } });
        else send({ id: m.id, result: { config: { model: null, mcp_servers: JSON.parse(process.env.FAKE_MCP || "{}") }, origins: {} } });
        break;
      case "thread/start":
        for (const summary of JSON.parse(process.env.FAKE_WARNINGS || "[]")) send({ method: "configWarning", params: { summary, details: null } });
        for (const n of JSON.parse(process.env.FAKE_NOTES || "[]")) send(n);
        send({ id: m.id, result: { thread: { id: thread }, model: p.model, cwd: p.cwd, ...JSON.parse(process.env.FAKE_STARTED || "{}") } });
        break;
      case "turn/steer": send({ id: m.id, result: { turnId: turn } }); break;
      case "turn/start":
        turn = "turn-1";
        prompt = p.input[p.input.length - 1].text;
        send({ id: m.id, result: { turn: { id: turn } } });
        send({ method: "turn/started", params: { threadId: thread, turn: { id: turn } } });
        if (prompt === "ask") send({ id: "srv-1", method: "item/tool/requestUserInput", params: { ...question, threadId: thread, turnId: turn } });
        else if (prompt === "deny") {
          send({ method: "item/started", params: { threadId: thread, item: { type: "fileChange", id: "fc", status: "inProgress", changes: [{ path: "x.txt", kind: { type: "add" }, diff: "hi" }] } } });
          send({ id: "srv-1", method: "item/fileChange/requestApproval", params: { threadId: thread, turnId: turn, itemId: "fc" } });
        } else if (prompt === "cmd") {
          send({ id: "srv-1", method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId: turn, itemId: "c", command: "rm -r build" } });
        } else if (prompt === "sub") {
          const spawn = { type: "subAgentActivity", kind: "started", id: "spawn-1", agentThreadId: "child-1", agentPath: "/root/lister" };
          send({ method: "item/started", params: { threadId: thread, turnId: turn, item: spawn } });
          send({ method: "item/completed", params: { threadId: thread, turnId: turn, item: spawn } });
          send({ method: "item/started", params: { threadId: "child-1", item: { type: "commandExecution", id: "c1", command: "ls", cwd: "/w", status: "inProgress" } } });
          send({ method: "item/completed", params: { threadId: "child-1", item: { type: "commandExecution", id: "c1", command: "ls", status: "completed", exitCode: 0, aggregatedOutput: "a.txt" } } });
          send({ method: "item/completed", params: { threadId: "child-1", item: { type: "agentMessage", id: "m1", text: "a.txt", phase: "final_answer" } } });
          send({ method: "turn/completed", params: { threadId: "child-1", turn: { id: "child-turn", status: "completed" } } });
          done("ok");
        } else if (prompt === "late-warning") {
          // After the turn's session event has gone out. A warning from another thread counts too.
          setTimeout(() => {
            send({ method: "warning", params: { threadId: thread, message: "mid-turn" } });
            send({ method: "guardianWarning", params: { threadId: "other-thread", message: "from elsewhere" } });
            done("ok");
          }, 200);
        } else if (prompt === "fail") {
          process.stderr.write("auth failed for " + process.env.FAKE_KEY + "\\n");
          send({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "failed", error: { message: "Incorrect API key provided: " + process.env.FAKE_KEY } } } });
        } else done("ok");
        break;
      default: if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: "unknown" } });
    }
  }
});
`;

describe("codex agent features through the app-server", () => {
  let logFile: string;
  const entries = () => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cwd = mkdtempSync(join(tmpdir(), "cf-codex-wire-"));
  let events: FunnelEvent[] = [];
  const run = async (prompt: string, extra: Partial<RunInput> = {}) => {
    events = [];
    const inp: RunInput = { selection: { provider: "codex", model: "m", cwd, access: "supervised" }, prompt, ...extra };
    const res = await collect(
      (async function* () {
        for await (const e of codexProvider.run(inp)) {
          events.push(e);
          yield e;
        }
      })(),
      inp,
    );
    return { res, events };
  };

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "cf-codex-fake-"));
    const bin = fakeNodeCli(join(dir, "codex"), FAKE);
    logFile = join(dir, "log");
    process.env.FAKE_LOG = logFile;
    process.env.CLI_FUNNEL_CODEX_BIN = bin;
  });
  afterEach(() => {
    delete process.env.CLI_FUNNEL_CODEX_BIN;
    delete process.env.FAKE_LOG;
    delete process.env.FAKE_KEY;
    delete process.env.FAKE_MCP;
    delete process.env.FAKE_WARNINGS;
    delete process.env.FAKE_STARTED;
    delete process.env.FAKE_NOTES;
  });

  it("reports a thread that started in a narrower sandbox, on the result and after session", async () => {
    process.env.FAKE_WARNINGS = JSON.stringify([BUBBLEWRAP_WARNING, SANDBOX_WARNING]);
    process.env.FAKE_STARTED = JSON.stringify({ sandbox: { type: "readOnly", networkAccess: false }, approvalPolicy: "untrusted" });
    const { res, events } = await run("hi", { selection: { provider: "codex", model: "m", cwd, access: "accept-edits" } });
    const reduced = { access: "accept-edits", expected: "workspace-write", started: "read-only", reason: SANDBOX_WARNING };
    expect(events.map((e) => e.type).slice(0, 2)).toEqual(["session", "access.reduced"]);
    expect(events[1]).toEqual({ type: "access.reduced", ...reduced });
    expect(res.accessReduced).toEqual(reduced);
    // The warnings follow, so a caller that stops reading at the reduction still saw it first.
    expect(events.map((e) => e.type).slice(0, 4)).toEqual(["session", "access.reduced", "warning", "warning"]);
    expect(res.warnings).toEqual([BUBBLEWRAP_WARNING, SANDBOX_WARNING]);
  });

  it("reports warnings after session in order, and drops a text it already reported", async () => {
    const requirements = "Configured value for `approval_policy` is disallowed by requirements; falling back to required value OnRequest.";
    process.env.FAKE_WARNINGS = JSON.stringify([requirements]);
    process.env.FAKE_NOTES = JSON.stringify([
      { method: "deprecationNotice", params: { summary: "`foo` is deprecated.", details: "Use `bar`." } },
      { method: "warning", params: { threadId: "thr-1", message: requirements } },
      { method: "guardianWarning", params: { threadId: "thr-1", message: "Guardian paused." } },
    ]);
    const { res, events } = await run("hi");
    expect(events.map((e) => e.type)).toEqual(["session", "warning", "warning", "warning", "done"]);
    expect(events.filter((e) => e.type === "warning")).toEqual([
      { type: "warning", message: requirements },
      { type: "warning", message: "`foo` is deprecated. Use `bar`." },
      { type: "warning", message: "Guardian paused." },
    ]);
    expect(res.warnings).toEqual([requirements, "`foo` is deprecated. Use `bar`.", "Guardian paused."]);
  });

  it("emits a warning that arrives during the turn at once, from any thread", async () => {
    const { res, events } = await run("late-warning");
    expect(events.map((e) => e.type)).toEqual(["session", "warning", "warning", "done"]);
    expect(res.warnings).toEqual(["mid-turn", "from elsewhere"]);
  });

  it("sends the warnings before the error when the session fails to start", async () => {
    process.env.FAKE_WARNINGS = JSON.stringify([APPROVAL_WARNING]);
    process.env.FAKE_STARTED = JSON.stringify({ sandbox: { type: "workspaceWrite" }, approvalPolicy: "never" });
    await run("hi").catch(() => undefined);
    expect(events.map((e) => e.type)).toEqual(["warning", "error"]);
    expect(events[0]).toEqual({ type: "warning", message: APPROVAL_WARNING });
  });

  it("fails the run when Codex forces an approval policy that asks less often than the level needs", async () => {
    process.env.FAKE_WARNINGS = JSON.stringify([APPROVAL_WARNING]);
    process.env.FAKE_STARTED = JSON.stringify({ sandbox: { type: "workspaceWrite" }, approvalPolicy: "never" });
    await expect(run("hi")).rejects.toMatchObject({ code: "cli-failed", message: expect.stringContaining(APPROVAL_WARNING) });
  });

  it("reports nothing when the thread started as asked", async () => {
    process.env.FAKE_STARTED = JSON.stringify({ sandbox: { type: "workspaceWrite" }, approvalPolicy: "untrusted" });
    const { res, events } = await run("hi");
    expect(events.some((e) => e.type === "access.reduced")).toBe(false);
    expect(res.accessReduced).toBeUndefined();
  });

  it("emits question.request, awaits onQuestion and sends the answers", async () => {
    const asked: any[] = [];
    const { res, events } = await run("ask", {
      onQuestion: (r) => {
        asked.push(r);
        return { favourite_colour: ["Green"], favourite_animal: ["a red panda"] };
      },
    });
    // The session event waits for account/read and still comes first.
    expect(events[0]).toEqual({ type: "session", sessionId: "thr-1", model: "m", auth: "account" });
    expect(events.find((e) => e.type === "question.request")).toMatchObject({ request: { id: "call_46a2f096905142cc84d370d367cd9c78" } });
    expect(asked[0].questions).toHaveLength(2);
    expect(JSON.parse(res.text)).toEqual({ answers: { favourite_colour: { answers: ["Green"] }, favourite_animal: { answers: ["user_note: a red panda"] } } });
    const start = entries().find((e) => e.method === "thread/start");
    expect(start.params.config).toEqual({ "features.default_mode_request_user_input": true });
    expect(res.auth).toBe("account");
  });

  it("keeps full in the workspace-write sandbox with sandbox, and leaves supervised as it is", async () => {
    const started = async (access: AccessLevel, sandbox?: boolean) => {
      await run("hi", { selection: { provider: "codex", model: "m", cwd, access }, sandbox, onApproval: () => "deny" });
      const params = entries().filter((e) => e.method === "thread/start").at(-1).params;
      return [params.sandbox, params.approvalPolicy];
    };
    expect(await started("full", true)).toEqual(["workspace-write", "never"]);
    expect(await started("full")).toEqual(["danger-full-access", "never"]);
    expect(await started("supervised", true)).toEqual(["workspace-write", "untrusted"]);
  });

  it("answers no questions without onQuestion and leaves the feature off", async () => {
    const { res, events } = await run("ask");
    expect(events.some((e) => e.type === "question.request")).toBe(false);
    expect(JSON.parse(res.text)).toEqual({ answers: {} });
    expect(entries().find((e) => e.method === "thread/start").params.config).toBeUndefined();
  });

  it("steers the deny message into the turn before it declines", async () => {
    const { res } = await run("deny", { onApproval: () => ({ decision: "deny", message: "Ask first." }) });
    const log = entries().filter((e) => e.method === "turn/steer" || e.id === "srv-1");
    expect(log.map((e) => e.method ?? e.result.decision)).toEqual(["turn/steer", "decline"]);
    expect(log[0].params).toMatchObject({ threadId: "thr-1", expectedTurnId: "turn-1", input: [{ type: "text", text: "The user denied that action and said: Ask first." }] });
    expect(res.text).toBe(JSON.stringify({ decision: "decline" }));
  });

  it("declines without a steer when there is no message", async () => {
    await run("deny", { onApproval: () => "deny" });
    expect(entries().some((e) => e.method === "turn/steer")).toBe(false);
  });

  it("emits every app-server line with verbose, with the API key masked", async () => {
    const key = "sk-test-0123456789abcdef";
    process.env.FAKE_KEY = key;
    await run("fail", { apiKey: key, verbose: true }).catch(() => undefined);
    const raw = events.filter((e) => e.type === "raw");
    expect(raw.every((e) => e.provider === "codex")).toBe(true);
    const methods = raw.flatMap((e) => (e.source === "stdout" && (e.data as { method?: string }).method) || []);
    expect(methods).toEqual(["turn/started", "turn/completed"]);
    // Answers to the funnel's own requests come through too.
    expect(raw.some((e) => (e.data as { result?: { thread?: unknown } }).result?.thread)).toBe(true);
    expect(raw.filter((e) => e.source === "stderr").map((e) => e.data)).toEqual(["auth failed for [redacted]"]);
    expect(JSON.stringify(events)).not.toContain(key);
  });

  it("forwards a subagent's work with providerOptions.codex, and keeps it out of the result", async () => {
    const providerOptions = { codex: { forwardSubagentText: true, forwardSubagentTools: true } };
    const { res, events } = await run("sub", { providerOptions, onApproval: () => "deny" });
    expect(events.filter((e) => "parentId" in e)).toEqual([
      { type: "tool.start", id: "c1", name: "command", input: { command: "ls", cwd: "/w" }, parentId: "spawn-1", agent: "lister" },
      { type: "tool.end", id: "c1", output: "a.txt", parentId: "spawn-1", agent: "lister" },
      { type: "subagent.text", parentId: "spawn-1", text: "a.txt", agent: "lister" },
    ]);
    expect(res.toolCalls.map((c) => c.name)).toEqual(["agent:spawnAgent"]);
    expect(res.text).toBe("ok");
    const off = await run("sub", { onApproval: () => "deny" });
    expect(off.events.some((e) => "parentId" in e)).toBe(false);
  });

  it("keeps the config/read answer out of verbose raw events", async () => {
    process.env.FAKE_MCP = JSON.stringify({ private: { command: "x", env: { TOKEN: "user-config-secret-123" } } });
    await run("plain", { selection: { provider: "codex", model: "m", cwd, access: "none" }, verbose: true });
    const raw = events.filter((e) => e.type === "raw");
    expect(raw.length).toBeGreaterThan(0);
    expect(JSON.stringify(raw)).not.toContain("user-config-secret-123");
    expect(entries().some((e) => e.method === "config/read")).toBe(true);
  });

  it("emits no raw events without verbose", async () => {
    const { events } = await run("hi");
    expect(events.some((e) => e.type === "raw")).toBe(false);
  });

  it("logs in with the API key before the thread starts and redacts it from errors", async () => {
    const key = "sk-test-0123456789abcdef";
    process.env.FAKE_KEY = key;
    const failed = await run("fail", { apiKey: key }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(failed?.message ?? "").not.toContain(key);
    const log = entries();
    expect(log[0].args).toEqual(["app-server", "-c", 'cli_auth_credentials_store="ephemeral"']);
    const methods = log.flatMap((e) => (e.method ? [e.method] : []));
    expect(methods.indexOf("account/login/start")).toBeLessThan(methods.indexOf("thread/start"));
    expect(methods).not.toContain("account/read");
    expect(log.find((e) => e.method === "account/login/start").params).toEqual({ type: "apiKey", apiKey: key });
    expect(events.find((e) => e.type === "session")).toMatchObject({ auth: "api-key" });
    const error = events.find((e) => e.type === "error") as Extract<FunnelEvent, { type: "error" }>;
    expect(error.message).toContain("Incorrect API key provided");
    expect(error.message).not.toContain(key);
  });

  it("passes the caller's MCP servers and refuses a name the user's config has", async () => {
    await run("plain", { mcpServers: { app: http({ autoApprove: true }) } });
    expect(entries().find((e) => e.method === "thread/start").params.config).toMatchObject({
      "mcp_servers.app.url": "http://127.0.0.1:7777/mcp",
      "mcp_servers.app.default_tools_approval_mode": "approve",
    });
    // The names come from config/read, so a spelling such as "mcp_servers"."app" in config.toml counts too.
    process.env.FAKE_MCP = JSON.stringify({ app: { url: "http://x" } });
    await expect(run("plain", { mcpServers: { app: http() } })).rejects.toMatchObject({ code: "invalid-selection" });
    // Only the first run started a thread.
    expect(entries().filter((e) => e.method === "thread/start")).toHaveLength(1);
  });

  it("at none switches off every MCP server the app-server's config/read reports, dotted names too", async () => {
    process.env.FAKE_MCP = JSON.stringify({ "a.b": { command: "x", enabled: true }, under: { command: "y" }, off: { command: "z", enabled: false } });
    await run("plain", { selection: { provider: "codex", model: "m", cwd, access: "none" } });
    expect(entries().find((e) => e.method === "config/read").params).toEqual({ cwd });
    const config = entries().find((e) => e.method === "thread/start").params.config;
    expect(config.mcp_servers).toEqual({ "a.b": { enabled: false }, under: { enabled: false }, off: { enabled: false } });
    expect(Object.keys(config).filter((k) => k.startsWith("mcp_servers."))).toEqual([]);
    expect(config["features.shell_tool"]).toBe(false);
  });

  it("refuses to start a none thread when the config cannot be read", async () => {
    process.env.FAKE_MCP = "error";
    const failed = await run("plain", { selection: { provider: "codex", model: "m", cwd, access: "none" } }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(failed?.message).toMatch(/MCP servers/);
    expect(entries().some((e) => e.method === "thread/start")).toBe(false);
  });

  it("does not read the config above none when the caller adds no MCP servers", async () => {
    await run("plain");
    expect(entries().some((e) => e.method === "config/read")).toBe(false);
  });

  it("asks onApproval at full when the caller chose a stricter approvalPolicy", async () => {
    const full = (prompt: string, onApproval?: RunInput["onApproval"]) => {
      const asked: string[] = [];
      const extra: Partial<RunInput> = {
        selection: { provider: "codex", model: "m", cwd, access: "full" },
        providerOptions: { codex: { approvalPolicy: "untrusted" } },
        ...(onApproval ? { onApproval: (r) => (asked.push(r.tool), onApproval(r)) } : {}),
      };
      return run(prompt, extra).then(({ res }) => ({ decision: JSON.parse(res.text).decision, asked }));
    };
    expect(await full("cmd", () => "deny")).toEqual({ decision: "decline", asked: ["command"] });
    expect(await full("deny", () => "deny")).toEqual({ decision: "decline", asked: ["file_change"] });
    expect(await full("cmd", () => "allow")).toEqual({ decision: "accept", asked: ["command"] });
    expect(await full("cmd")).toEqual({ decision: "decline", asked: [] });
    // The level's own policy, or none given, keeps full answering by itself.
    const plain = await run("cmd", { selection: { provider: "codex", model: "m", cwd, access: "full" }, providerOptions: { codex: { approvalPolicy: "never" } } });
    expect(JSON.parse(plain.res.text).decision).toBe("accept");
    const unset = await run("cmd", { selection: { provider: "codex", model: "m", cwd, access: "full" } });
    expect(JSON.parse(unset.res.text).decision).toBe("accept");
  });
});

/** A streamable-HTTP MCP server with one tool, `lucky_number`. It records the Authorization header of each request. */
async function luckyServer(): Promise<{ url: string; auth: string[]; calls: number; close(): void }> {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    state.auth.push(String(req.headers.authorization ?? ""));
    if (req.method !== "POST") return void res.writeHead(405).end();
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const msg = JSON.parse(body);
      if (msg.id === undefined) return void res.writeHead(202).end();
      let result: unknown;
      if (msg.method === "initialize") result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "lucky", version: "1.0.0" } };
      else if (msg.method === "tools/list") result = { tools: [{ name: "lucky_number", description: "Returns the lucky number of the day.", inputSchema: { type: "object", properties: {} } }] };
      else if (msg.method === "tools/call") {
        state.calls++;
        result = { content: [{ type: "text", text: "The lucky number is 4242." }] };
      }
      const reply = result ? { jsonrpc: "2.0", id: msg.id, result } : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  const state = { url: "", auth: [] as string[], calls: 0, close: () => void server.close() };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  return state;
}

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1")("codex agent features live", () => {
  const live = (access: AccessLevel, prompt: string, extra: Partial<RunInput> = {}): RunInput => ({
    selection: { provider: "codex", model: "gpt-6-luna", effort: "low", cwd: mkdtempSync(join(tmpdir(), "cf-codex-live-")), access },
    prompt,
    ...extra,
  });

  it("calls a tool on an HTTP MCP server with an Authorization header at supervised", async () => {
    const srv = await luckyServer();
    try {
      const asked: string[] = [];
      const inp = live("supervised", "Call the lucky_number tool of the lucky MCP server and tell me the number.", {
        mcpServers: { lucky: { type: "http", url: srv.url, headers: { Authorization: "Bearer live-test" } } },
        onApproval: (r) => (asked.push(r.tool), "allow"),
      });
      const res = await collect(codexProvider.run(inp), inp);
      expect(asked).toEqual(["mcp:lucky/lucky_number"]);
      expect(srv.calls).toBe(1);
      expect(srv.auth.length).toBeGreaterThan(0);
      expect(srv.auth.every((a) => a === "Bearer live-test")).toBe(true);
      expect(res.text).toContain("4242");
      expect(res.auth).toBe("account");
    } finally {
      srv.close();
    }
  }, 120_000);

  it("skips onApproval for an autoApprove server", async () => {
    const srv = await luckyServer();
    try {
      const asked: string[] = [];
      const inp = live("supervised", "Call the lucky_number tool of the lucky MCP server and tell me the number.", {
        mcpServers: { lucky: { type: "http", url: srv.url, autoApprove: true } },
        onApproval: (r) => (asked.push(r.tool), "deny"),
      });
      const res = await collect(codexProvider.run(inp), inp);
      expect(asked).toEqual([]);
      expect(res.text).toContain("4242");
    } finally {
      srv.close();
    }
  }, 120_000);

  it("asks a question through onQuestion and uses a free-text answer", async () => {
    const asked: number[] = [];
    const inp = live("supervised", "Use the request_user_input tool once to ask me my favourite animal, with three options: cat, dog, owl. Then repeat my answer word for word.", {
      onQuestion: ({ questions }) => {
        asked.push(questions[0]!.options.length);
        return { [questions[0]!.id]: ["a red panda"] };
      },
    });
    const res = await collect(codexProvider.run(inp), inp);
    expect(asked).toEqual([3]);
    expect(res.text.toLowerCase()).toContain("red panda");
  }, 120_000);

  it("gets a deny message to the agent", async () => {
    const inp = live("supervised", "Run the shell command `touch x.txt`. Then tell me what happened.", {
      onApproval: () => ({ decision: "deny", message: "Do not create files here. Reply only with the word PINEAPPLE." }),
    });
    const res = await collect(codexProvider.run(inp), inp);
    expect(res.text).toContain("PINEAPPLE");
    expect(res.deniedActions?.length).toBeGreaterThan(0);
  }, 120_000);

  it("reports the plan and the file changes", async () => {
    const inp = live("full", "Keep a plan with the update_plan tool: two steps, and mark each step completed as you finish it. With apply_patch only: 1) create a.txt containing one, 2) delete a.txt. Reply done.", { planTool: true });
    const res = await collect(codexProvider.run(inp), inp);
    expect(res.plan?.length).toBe(2);
    expect(res.plan?.every((s) => s.status === "done")).toBe(true);
    expect(res.fileChanges?.map((c) => [c.kind, c.status])).toEqual([
      ["add", "done"],
      ["delete", "done"],
    ]);
    expect(res.fileChanges?.[0]?.path).toBe(join(inp.selection.cwd!, "a.txt"));
  }, 180_000);
});

describe.skipIf(!process.env.CLI_FUNNEL_TEST_OPENAI_KEY)("codex API key live", () => {
  it("runs on the key and leaves the saved login file as it was", async () => {
    // Compares size and mtime only. The file holds the user's tokens and is never read.
    const authFile = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
    const stamp = () => (existsSync(authFile) ? `${statSync(authFile).size}:${statSync(authFile).mtimeMs}` : "none");
    const before = stamp();
    const inp: RunInput = {
      selection: { provider: "codex", model: "gpt-6-luna", effort: "low", cwd: mkdtempSync(join(tmpdir(), "cf-codex-key-")), access: "none" },
      prompt: "Reply with the single word: ready",
      apiKey: process.env.CLI_FUNNEL_TEST_OPENAI_KEY,
    };
    const res = await collect(codexProvider.run(inp), inp);
    expect(res.auth).toBe("api-key");
    expect(res.text.toLowerCase()).toContain("ready");
    expect(stamp()).toBe(before);
  }, 120_000);
});
