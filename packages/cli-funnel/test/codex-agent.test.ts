import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fakeNodeCli } from "./fake-cli.js";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { denyNote, effectiveReply, isQuestion, toApprovalRequest, toQuestionReply, toQuestionRequest, toReply } from "../src/providers/codex/approvals.js";
import { authKind } from "../src/providers/codex/auth.js";
import { fileChangeEvents, planEvent, Translator } from "../src/providers/codex/events.js";
import { codexProvider } from "../src/providers/codex/index.js";
import { appServerArgs } from "../src/providers/codex/live.js";
import { agentConfig, mcpConfig } from "../src/providers/codex/options.js";
import { configDeclares } from "../src/providers/codex/tools.js";
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

const input = (access: AccessLevel, extra: Partial<RunInput> = {}): RunInput => ({ selection: { provider: "codex", model: "m", cwd: "/tmp", access }, prompt: "x", ...extra });
const http = (extra: Partial<McpServer> = {}): McpServer => ({ type: "http", url: "http://127.0.0.1:7777/mcp", ...extra }) as McpServer;

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
    const ctx = { items: new Map(), mcpCalls: new Map([["call-1", { id: "call-1", server: "srv", tool: "t", arguments: { q: 1 } }]]) };
    expect(toApprovalRequest(req, ctx)).toEqual({ id: "call-1", tool: "mcp:srv/t", input: { q: 1 }, description: "Allow?" });
    expect(toReply(req, "allow")).toEqual({ result: { answers: { "mcp_tool_call_approval_call-1": { answers: ["Allow"] } } } });
    expect(toReply(req, "deny")).toEqual({ result: { answers: { "mcp_tool_call_approval_call-1": { answers: ["Cancel"] } } } });
  });
});

describe("codex MCP approvals with calls in flight", () => {
  const call = (id: string, tool: string, args: unknown) => [id, { id, server: "srv", tool, arguments: args }] as const;
  const elicit = (params: unknown) => ({
    id: 9,
    method: "mcpServer/elicitation/request",
    params: { serverName: "srv", message: "Allow?", _meta: { codex_approval_kind: "mcp_tool_call", tool_params: params } },
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

  it("switches plans on below none and questions on with onQuestion", () => {
    expect(agentConfig(input("supervised"))).toEqual({ "tools.update_plan.enabled": true });
    expect(agentConfig(input("none"))).toEqual({});
    expect(agentConfig(input("none", { onQuestion: () => null }))).toEqual({ "features.default_mode_request_user_input": true });
  });

  it("finds caller server names that the user's config already declares", () => {
    const home = mkdtempSync(join(tmpdir(), "cf-codex-home-"));
    writeFileSync(join(home, "config.toml"), '[mcp_servers.taken]\ncommand = "x"\n');
    expect(configDeclares(["taken", "free"], tmpdir(), { CODEX_HOME: home })).toEqual(["taken"]);
    expect(configDeclares([], tmpdir(), { CODEX_HOME: home })).toEqual([]);
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
      case "thread/start": send({ id: m.id, result: { thread: { id: thread }, model: p.model, cwd: p.cwd } }); break;
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
        } else if (prompt === "fail") {
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
    expect(start.params.config).toEqual({ "tools.update_plan.enabled": true, "features.default_mode_request_user_input": true });
    expect(res.auth).toBe("account");
  });

  it("answers no questions without onQuestion and leaves the feature off", async () => {
    const { res, events } = await run("ask");
    expect(events.some((e) => e.type === "question.request")).toBe(false);
    expect(JSON.parse(res.text)).toEqual({ answers: {} });
    expect(entries().find((e) => e.method === "thread/start").params.config).toEqual({ "tools.update_plan.enabled": true });
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
    const home = mkdtempSync(join(tmpdir(), "cf-codex-home-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), "[mcp_servers.app]\nurl = 'http://x'\n");
    await expect(run("plain", { mcpServers: { app: http() }, env: { CODEX_HOME: home } })).rejects.toMatchObject({ code: "invalid-selection" });
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
    const inp = live("full", "Keep a plan with the update_plan tool: two steps, and mark each step completed as you finish it. With apply_patch only: 1) create a.txt containing one, 2) delete a.txt. Reply done.");
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
