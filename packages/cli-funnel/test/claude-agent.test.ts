import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fakeNodeCli } from "./fake-cli.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArgs, claudeProvider, questionAnswers, questionRequest } from "../src/providers/claude/index.js";
import { editPath, newClaudeTrack, parseClaudeMessage } from "../src/providers/claude/parser.js";
import { collect } from "./helpers.js";
import type { AccessLevel, FunnelEvent, McpServer, RunInput, Selection } from "../src/types.js";

const fixtureText = (name: string) => readFileSync(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url), "utf8");
const fixtureLines = (name: string) => fixtureText(name).split("\n").filter(Boolean).map((l) => JSON.parse(l));

const sel = (over: Partial<Selection> = {}): Selection => ({
  provider: "claude", model: "claude-haiku-4-5-20251001", cwd: "/tmp", access: "accept-edits", ...over,
});
const input = (access: AccessLevel, extra: Partial<RunInput> = {}): RunInput => ({ selection: sel({ access }), prompt: "x", ...extra });
const outcome = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "error";
  }
};
const mcpArg = (args: string[]) => {
  const a = args.find((x) => x.startsWith("--mcp-config="));
  return a ? JSON.parse(a.slice("--mcp-config=".length)) : undefined;
};

const app: McpServer = { type: "http", url: "http://127.0.0.1:7777/mcp", headers: { Authorization: "Bearer t" }, toolTimeoutSec: 900, autoApprove: true };

describe("claude MCP servers", () => {
  it("maps an HTTP server with headers and a per-server timeout in ms", () => {
    const args = buildArgs(input("supervised", { onApproval: () => "deny", mcpServers: { app } }));
    expect(mcpArg(args)).toEqual({ mcpServers: { app: { type: "http", url: app.url, headers: { Authorization: "Bearer t" }, timeout: 900_000 } } });
    expect(args.some((a) => a.startsWith("--allowed-tools"))).toBe(false);
  });

  it("takes a stdio server at full only", () => {
    const stdio: McpServer = { type: "stdio", command: "node", args: ["s.js"], env: { K: "v" }, toolTimeoutSec: 30 };
    const args = buildArgs(input("full", { mcpServers: { s: stdio } }));
    expect(mcpArg(args)).toEqual({ mcpServers: { s: { type: "stdio", command: "node", args: ["s.js"], env: { K: "v" }, timeout: 30_000 } } });
    for (const access of ["supervised", "accept-edits", "auto"] as const) {
      expect(outcome(() => buildArgs(input(access, { onApproval: () => "deny", mcpServers: { s: stdio } })))).toBe("invalid-selection");
    }
  });

  it("refuses an HTTP server at none", () => {
    expect(outcome(() => buildArgs(input("none", { mcpServers: { app } })))).toBe("invalid-selection");
  });

  it("merges with providerOptions.claude.mcpConfig and refuses a name in both", () => {
    const providerOptions = { claude: { mcpConfig: { mcpServers: { x: { command: "x" } } } } };
    const args = buildArgs(input("full", { providerOptions, mcpServers: { app } }));
    expect(Object.keys(mcpArg(args).mcpServers)).toEqual(["x", "app"]);
    expect(outcome(() => buildArgs(input("full", { providerOptions, mcpServers: { x: app } })))).toBe("invalid-selection");
  });

  it("passes the config as a file path when one is given", () => {
    const args = buildArgs(input("auto", { mcpServers: { app } }), undefined, false, "/tmp/x/mcp.json");
    expect(args).toContain("--mcp-config=/tmp/x/mcp.json");
  });
});

describe("claude prompt tool", () => {
  const promptTool = (i: RunInput) => buildArgs(i).includes("--permission-prompt-tool");

  it("is on for questions at every level with tools", () => {
    for (const access of ["supervised", "accept-edits", "auto", "full"] as const) {
      expect(promptTool(input(access, { onApproval: access === "supervised" ? () => "deny" : undefined, onQuestion: () => null }))).toBe(true);
    }
    expect(promptTool(input("none", { onQuestion: () => null }))).toBe(false);
  });

  it("is on for an auto-approved MCP server below full", () => {
    expect(promptTool(input("accept-edits", { mcpServers: { app } }))).toBe(true);
    expect(promptTool(input("accept-edits", { mcpServers: { app: { ...app, autoApprove: false } } }))).toBe(false);
    expect(promptTool(input("full", { mcpServers: { app } }))).toBe(false);
  });

  it("stays off as before without approvals, questions or auto-approved servers", () => {
    expect(promptTool(input("accept-edits"))).toBe(false);
    expect(promptTool(input("full", { onApproval: () => "allow" }))).toBe(false);
  });
});

describe("claude questions", () => {
  const ask = fixtureLines("question").find((l) => l.type === "control_request").request;

  it("maps AskUserQuestion input to a question request", () => {
    expect(questionRequest("t1", ask.input)).toEqual({
      id: "t1",
      questions: [{
        id: "0",
        header: "Color preference",
        question: "Which color do you prefer?",
        options: [
          { label: "Red", description: "The color red" },
          { label: "Green", description: "The color green" },
          { label: "Blue", description: "The color blue" },
        ],
        multiSelect: false,
        allowOther: true,
      }],
    });
    expect(questionRequest("t1", { questions: [] })).toBeUndefined();
  });

  it("keys answers by question text and joins several with commas", () => {
    const request = questionRequest("t", { questions: [{ question: "A?", options: [], multiSelect: true }, { question: "B?", options: [] }, { question: "C?", options: [] }] })!;
    expect(questionAnswers(request, { 0: ["x", "y"], 1: ["free text"], 2: [] })).toEqual({ "A?": "x, y", "B?": "free text" });
  });
});

describe("claude plans", () => {
  it("emits the TodoWrite list as a plan and keeps the tool call", () => {
    const ev = fixtureLines("plan-todowrite").flatMap((l) => parseClaudeMessage(l));
    const i = ev.findIndex((e) => e.type === "plan");
    expect(ev[i - 1]).toMatchObject({ type: "tool.start", name: "TodoWrite" });
    expect(ev[i]).toEqual({
      type: "plan",
      steps: [
        { text: "Pick topic", status: "done" },
        { text: "Write lines", status: "in_progress" },
        { text: "Review", status: "pending" },
      ],
    });
  });

  it("builds the plan from TaskCreate and TaskUpdate results", async () => {
    const track = newClaudeTrack();
    const ev = fixtureLines("plan-tasks").flatMap((l) => parseClaudeMessage(l, false, track));
    const plans = ev.filter((e) => e.type === "plan");
    expect(plans).toHaveLength(5);
    expect(plans[0]).toEqual({ type: "plan", steps: [{ text: "Pick topic", status: "pending" }] });
    const last = [
      { text: "Pick topic", status: "done" },
      { text: "Write lines", status: "in_progress" },
      { text: "Review", status: "pending" },
    ];
    expect(plans.at(-1)).toEqual({ type: "plan", steps: last });
    const result = await collect((async function* () { yield* ev; })(), input("auto"));
    expect(result.plan).toEqual(last);
  });

  it("drops deleted tasks and ignores tasks it never saw created", () => {
    const track = newClaudeTrack();
    track.tasks.push({ id: "1", text: "a", status: "pending" }, { id: "2", text: "b", status: "pending" });
    const call = (id: string, taskInput: object) => [
      { type: "assistant", message: { content: [{ type: "tool_use", id, name: "TaskUpdate", input: taskInput }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, tool_use_result: { success: true } },
    ];
    const ev = [...call("u1", { taskId: "1", status: "deleted" }), ...call("u2", { taskId: "9", status: "completed" })].flatMap((l) => parseClaudeMessage(l, false, track));
    expect(ev.filter((e) => e.type === "plan")).toEqual([{ type: "plan", steps: [{ text: "b", status: "pending" }] }]);
  });
});

/** Tool call ids in file-changes.ndjson: the Write that adds new.txt and the denied Write of deny.txt. */
const IDS = { add: "toolu_01D3nNFevoQpnXJwAj1zgQ7n", deny: "toolu_01SUdmrTqih7BuW8i7DFKP6w" };

describe("claude file changes", () => {
  it("resolves the path of edit tools only", () => {
    expect(editPath("Write", { file_path: "a/b.txt" }, "/p")).toBe(resolve("/p", "a/b.txt"));
    expect(editPath("NotebookEdit", { notebook_path: "/n.ipynb" }, "/p")).toBe("/n.ipynb");
    expect(editPath("Read", { file_path: "/p/a.txt" }, "/p")).toBeUndefined();
    expect(editPath("Edit", {}, "/p")).toBeUndefined();
  });

  it("settles a failed edit as declined when the result lists it as a permission denial", () => {
    // No denial from the provider here, as when a permission rule refused the call. The existence check is stubbed.
    const track = newClaudeTrack();
    const ev: FunnelEvent[] = [];
    for (const l of fixtureLines("file-changes")) {
      for (const e of parseClaudeMessage(l, false, track)) {
        ev.push(e);
        const path = e.type === "tool.start" ? editPath(e.name, e.input, "/home/user/project") : undefined;
        if (e.type === "tool.start" && path) track.edits.set(e.id, { path, existed: path.endsWith("existing.txt") });
      }
    }
    const changes = ev.filter((e) => e.type === "file.change");
    expect(changes.map((e) => [(e as { path: string }).path, (e as { kind: string }).kind, (e as { status: string }).status])).toEqual([
      ["/home/user/project/new.txt", "add", "done"],
      ["/home/user/project/existing.txt", "update", "done"],
      ["/home/user/project/existing.txt", "update", "failed"],
      ["/home/user/project/deny.txt", "add", "declined"],
    ]);
    // Held changes come out before done.
    expect(ev.findIndex((e) => e.type === "file.change" && e.id === IDS.deny)).toBeLessThan(ev.findIndex((e) => e.type === "done"));
  });

  it("uses Write's own create or update report over the existence check", () => {
    const track = newClaudeTrack();
    track.edits.set("w1", { path: "/p/a.txt", existed: true });
    const ev = parseClaudeMessage(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "File created" }] }, tool_use_result: { type: "create", filePath: "/p/a.txt" } },
      false,
      track,
    );
    expect(ev.find((e) => e.type === "file.change")).toEqual({ type: "file.change", id: "w1", path: "/p/a.txt", kind: "add", status: "done" });
  });
});

describe("claude auth", () => {
  it("reports the login kind from apiKeySource", () => {
    const init = (apiKeySource?: string) => parseClaudeMessage({ type: "system", subtype: "init", session_id: "s", model: "m", apiKeySource })[0];
    expect(init("none")).toMatchObject({ auth: "account" });
    expect(init("ANTHROPIC_API_KEY")).toMatchObject({ auth: "api-key" });
    expect(init()).not.toHaveProperty("auth");
  });
});

// A fake `claude` that replays a fixture. It writes the fixture's lines after the first user message, stops after each
// control_request until a control_response arrives, and logs its start (args, API key, MCP config) and every response.
const FAKE_CLAUDE = `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.310 (Claude Code)"); process.exit(0); }
const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + "\\n");
const mcpArg = args.find((a) => a.startsWith("--mcp-config="));
let mcp;
if (mcpArg) {
  const v = mcpArg.slice("--mcp-config=".length);
  mcp = v.startsWith("{") ? { inline: JSON.parse(v) } : { mode: fs.statSync(v).mode & 0o777, content: JSON.parse(fs.readFileSync(v, "utf8")) };
}
log({ kind: "start", args, apiKey: process.env.ANTHROPIC_API_KEY ?? null, mcp });
const lines = fs.readFileSync(process.env.FAKE_FIXTURE, "utf8").split("\\n").filter(Boolean);
let i = 0;
const pump = () => {
  while (i < lines.length) {
    const l = lines[i++];
    process.stdout.write(l + "\\n");
    if (JSON.parse(l).type === "control_request") return;
  }
};
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, n));
    buf = buf.slice(n + 1);
    if (m.type === "control_response") log({ kind: "response", response: m.response });
    if (m.type === "user" || m.type === "control_response") pump();
  }
});
process.stdin.on("end", () => process.exit(0));
`;

describe("claude control requests (fake CLI)", () => {
  let dir: string;
  let logFile: string;
  const logged = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const responses = () => logged().filter((l) => l.kind === "response").map((l) => l.response.response);

  /** Writes a fixture for the fake CLI, with the recorded project folder replaced by `dir`. */
  const replay = (fixture: string | object[]) => {
    const text = typeof fixture === "string" ? fixtureText(fixture) : fixture.map((l) => JSON.stringify(l)).join("\n");
    const file = join(dir, "fixture.ndjson");
    // Recorded paths become native paths under `dir`, escaped for the JSON strings they sit in.
    const native = text.replace(/\/home\/user\/project((?:\/[^"/]+)*)/g, (_, rest: string) => JSON.stringify(join(dir, ...rest.split("/").filter(Boolean))).slice(1, -1));
    writeFileSync(file, native);
    process.env.FAKE_FIXTURE = file;
  };
  const run = async (i: RunInput) => {
    const events: FunnelEvent[] = [];
    for await (const e of claudeProvider.run(i)) events.push(e);
    return events;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-claude-agent-"));
    logFile = join(dir, "log");
    process.env.CLI_FUNNEL_CLAUDE_BIN = fakeNodeCli(join(dir, "claude"), FAKE_CLAUDE);
    process.env.FAKE_LOG = logFile;
  });

  afterEach(() => {
    delete process.env.CLI_FUNNEL_CLAUDE_BIN;
    delete process.env.FAKE_LOG;
    delete process.env.FAKE_FIXTURE;
  });

  it("round-trips a question with three options and a free-text answer", async () => {
    replay("question");
    const asked: unknown[] = [];
    const events = await run({
      selection: sel({ cwd: dir, access: "full" }),
      prompt: "x",
      onQuestion: (r) => (asked.push(r), { 0: ["Purple with green stripes"] }),
    });
    expect(logged()[0].args).toEqual(expect.arrayContaining(["--permission-prompt-tool", "stdio"]));
    const request = events.find((e) => e.type === "question.request");
    expect(request).toMatchObject({ request: { questions: [{ id: "0", question: "Which color do you prefer?", allowOther: true }] } });
    expect((request as { request: { questions: { options: unknown[] }[] } }).request.questions[0]!.options).toHaveLength(3);
    expect(asked).toHaveLength(1);
    expect(events.some((e) => e.type === "approval.request")).toBe(false);
    const [reply] = responses();
    expect(reply.behavior).toBe("allow");
    expect(reply.updatedInput.answers).toEqual({ "Which color do you prefer?": "Purple with green stripes" });
    expect(reply.updatedInput.questions).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", text: "Purple with green stripes." });
  });

  it("denies a question the user did not answer", async () => {
    replay("question");
    await run({ selection: sel({ cwd: dir, access: "auto" }), prompt: "x", onQuestion: () => null });
    expect(responses()).toEqual([{ behavior: "deny", message: "The user did not answer." }]);
  });

  it("writes the caller's deny message to stdin and reports file changes", async () => {
    replay("file-changes");
    writeFileSync(join(dir, "existing.txt"), "one\ntwo\n");
    const events = await run({
      selection: sel({ cwd: dir, access: "supervised" }),
      prompt: "x",
      onApproval: (r) => (JSON.stringify(r.input).includes("deny.txt") ? { decision: "deny", message: "Not that file." } : "allow"),
    });
    expect(responses().map((r) => r.behavior)).toEqual(["allow", "allow", "deny"]);
    expect(responses()[2]).toEqual({ behavior: "deny", message: "Not that file." });
    const changes = events.filter((e) => e.type === "file.change");
    expect(changes).toEqual([
      { type: "file.change", id: IDS.add, path: join(dir, "new.txt"), kind: "add", status: "done" },
      { type: "file.change", id: expect.any(String), path: join(dir, "existing.txt"), kind: "update", status: "done" },
      // The denied change is reported with its tool result. The failed one waits for the result's denial list.
      { type: "file.change", id: IDS.deny, path: join(dir, "deny.txt"), kind: "add", status: "declined" },
      { type: "file.change", id: expect.any(String), path: join(dir, "existing.txt"), kind: "update", status: "failed" },
    ]);
    const at = (pred: (e: FunnelEvent) => boolean) => events.findIndex(pred);
    expect(at((e) => e.type === "file.change" && e.status === "declined")).toBeLessThan(at((e) => e.type === "usage"));
  });

  it("denies other prompts without asking when only onQuestion turned the prompt tool on", async () => {
    replay([
      { type: "system", subtype: "init", session_id: "s", model: "m" },
      { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls /" }, tool_use_id: "t1" } },
      { type: "result", subtype: "success", is_error: false, result: "ok", permission_denials: [{ tool_name: "Bash", tool_use_id: "t1", tool_input: {} }] },
    ]);
    let approvals = 0;
    const events = await run({ selection: sel({ cwd: dir, access: "full" }), prompt: "x", onQuestion: () => null, onApproval: () => (approvals++, "allow") });
    expect(approvals).toBe(0);
    expect(events.some((e) => e.type === "approval.request")).toBe(false);
    expect(responses()).toEqual([{ behavior: "deny", message: "Claude requested permissions to use Bash, but you haven't granted it yet." }]);
  });

  it("allows tools of an auto-approved server and asks for everything else", async () => {
    const call = (n: number, mcp_server: object) => ({
      type: "control_request", request_id: `r${n}`,
      request: { subtype: "can_use_tool", tool_name: "mcp__app__secret_word", mcp_server, input: {}, tool_use_id: `t${n}` },
    });
    replay([
      { type: "system", subtype: "init", session_id: "s", model: "m" },
      call(1, { name: "app", source: "dynamic" }),
      // A connector whose tool names look the same, and a server the caller did not mark.
      call(2, { name: "app", source: "claudeai" }),
      call(3, { name: "other", source: "dynamic" }),
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ]);
    const asked: string[] = [];
    await run({
      selection: sel({ cwd: dir, access: "supervised" }),
      prompt: "x",
      mcpServers: { app, other: { type: "http", url: "http://127.0.0.1:7778/mcp" } },
      onApproval: (r) => (asked.push(r.id), "deny"),
    });
    expect(responses().map((r) => r.behavior)).toEqual(["allow", "deny", "deny"]);
    expect(asked).toEqual(["t2", "t3"]);
    const start = logged()[0];
    expect(start.mcp.mode).toBe(0o600);
    expect(Object.keys(start.mcp.content.mcpServers)).toEqual(["app", "other"]);
    expect(start.args.join(" ")).not.toContain("Bearer");
  });

  it("runs on the API key from the run, through the environment", async () => {
    replay([{ type: "system", subtype: "init", session_id: "s", model: "m", apiKeySource: "ANTHROPIC_API_KEY" }, { type: "result", subtype: "success", is_error: false, result: "ok" }]);
    const result = await collect(claudeProvider.run({ selection: sel({ cwd: dir, access: "auto" }), prompt: "x", apiKey: "sk-ant-test", env: { ANTHROPIC_API_KEY: "other" } }), input("auto"));
    expect(logged()[0].apiKey).toBe("sk-ant-test");
    expect(logged()[0].args.join(" ")).not.toContain("sk-ant-test");
    expect(result.auth).toBe("api-key");
  });
});

describe.skipIf(!process.env.CLI_FUNNEL_TEST_ANTHROPIC_KEY)("claude live with an API key", () => {
  it("runs on the key and reports it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cf-claude-key-"));
    const i: RunInput = { selection: sel({ cwd, access: "none" }), prompt: "Reply with just: ok", apiKey: process.env.CLI_FUNNEL_TEST_ANTHROPIC_KEY };
    const result = await collect(claudeProvider.run(i), i);
    expect(result.auth).toBe("api-key");
    expect(result.text.length).toBeGreaterThan(0);
  }, 120_000);
});
