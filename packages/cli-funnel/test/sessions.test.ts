import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFunnel, type Funnel } from "../src/funnel.js";
import { fingerprint, type SessionOptions } from "../src/sessions.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

// A fake `claude -p --input-format stream-json`: answers each user message with init and result, and keeps reading
// stdin until it closes. A prompt that starts with "slow" gets no answer. Each start is logged with its pid and args.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, args }) + "\\n");
const r = args.indexOf("--resume");
const sid = r >= 0 ? args[r + 1] : "sess-" + process.pid;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let n = 0;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.type === "control_response") {
      const answer = "approval:" + m.response.response.behavior + "#" + n;
      send({ type: "result", subtype: "success", is_error: false, result: answer, session_id: sid });
      continue;
    }
    if (m.type !== "user") continue;
    n++;
    const text = m.message.content;
    send({ type: "system", subtype: "init", session_id: sid, model: "m" });
    if (text.startsWith("slow")) continue;
    if (text.startsWith("ask")) {
      send({ type: "control_request", request_id: "r" + n, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "t" + n } });
      continue;
    }
    const answer = text + "#" + n + "@" + process.pid;
    send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: answer } } });
    send({ type: "result", subtype: "success", is_error: false, result: answer, session_id: sid });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

// A fake `codex app-server`: one thread, turns answered at once, except prompts that start with "slow", which wait
// for turn/steer or turn/interrupt.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.160.0"); process.exit(0); }
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, args }) + "\\n");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let thread;
let n = 0;
let pending;
const complete = (turnId, text) => {
  send({ method: "item/agentMessage/delta", params: { threadId: thread, delta: text } });
  send({ method: "item/completed", params: { threadId: thread, item: { type: "agentMessage", text } } });
  send({ method: "turn/completed", params: { threadId: thread, turn: { id: turnId, status: "completed" } } });
};
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const p = m.params || {};
    if (m.id === "ask" && pending) {
      complete(pending.turnId, "approval:" + m.result.decision);
      pending = undefined;
      continue;
    }
    fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, method: m.method, params: p }) + "\\n");
    switch (m.method) {
      case "initialize": send({ id: m.id, result: {} }); break;
      case "thread/start": thread = "thr-" + process.pid; send({ id: m.id, result: { thread: { id: thread }, model: p.model } }); break;
      case "thread/resume":
        if (p.threadId === "missing") { send({ id: m.id, error: { code: -32600, message: "no rollout found" } }); break; }
        thread = p.threadId; send({ id: m.id, result: { thread: { id: thread }, model: p.model } }); break;
      case "turn/start": {
        const turnId = "turn-" + ++n;
        send({ id: m.id, result: { turn: { id: turnId } } });
        send({ method: "turn/started", params: { threadId: thread, turn: { id: turnId } } });
        const text = p.input[p.input.length - 1].text;
        if (text.startsWith("slow")) pending = { turnId, text };
        else if (text.startsWith("ask")) {
          pending = { turnId, text };
          send({ id: "ask", method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId, itemId: "i1", command: "ls", cwd: "/" } });
        }
        else complete(turnId, text + "#" + n + "@" + process.pid);
        break;
      }
      case "turn/steer":
        if (!pending || p.expectedTurnId !== pending.turnId) { send({ id: m.id, error: { code: -32600, message: "no active turn" } }); break; }
        send({ id: m.id, result: { turnId: pending.turnId } });
        complete(pending.turnId, pending.text + "+" + p.input[0].text);
        pending = undefined;
        break;
      case "turn/interrupt":
        send({ id: m.id, result: {} });
        send({ method: "turn/completed", params: { threadId: thread, turn: { id: p.turnId, status: "interrupted" } } });
        pending = undefined;
        break;
    }
  }
});
`;

function fake(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-sessions-"));
  const file = join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

let log: string;
const entries = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { pid: number; args?: string[]; method?: string; params?: any })
    : [];
const spawns = () => entries().filter((e) => e.args);

let funnel: Funnel | undefined;
const make = (sessions?: SessionOptions) => {
  funnel = createFunnel({ allowUnlistedModels: true, sessions });
  return funnel;
};

beforeEach(() => {
  log = join(mkdtempSync(join(tmpdir(), "cf-log-")), "log");
  process.env.FAKE_LOG = log;
  process.env.CLI_FUNNEL_CLAUDE_BIN = fake("claude", FAKE_CLAUDE);
  process.env.CLI_FUNNEL_CODEX_BIN = fake("codex", FAKE_CODEX);
});

afterEach(() => {
  funnel?.close();
  funnel = undefined;
  delete process.env.CLI_FUNNEL_CLAUDE_BIN;
  delete process.env.CLI_FUNNEL_CODEX_BIN;
  delete process.env.FAKE_LOG;
});

const claude = (prompt: string, extra: Partial<RunInput> = {}): RunInput => ({
  selection: { provider: "claude", model: "m", cwd: tmpdir(), access: "auto" },
  prompt,
  ...extra,
});
const codex = (prompt: string, extra: Partial<RunInput> = {}): RunInput => ({
  selection: { provider: "codex", model: "m", cwd: tmpdir(), access: "auto" },
  prompt,
  ...extra,
});

describe("sessions off (default)", () => {
  it("starts one process per turn, as before", async () => {
    const f = make();
    const a = await f.run(claude("one"));
    const b = await f.run(claude("two", { sessionId: a.sessionId }));
    expect(spawns()).toHaveLength(2);
    expect(spawns()[1]!.args).toContain("--resume");
    expect(b.text).toMatch(/^two#1@/);
    expect(f.sessions()).toEqual([]);
    await expect(f.steer(a.sessionId!, "x")).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("claude live sessions", () => {
  it("runs the next turn on the same process", async () => {
    const f = make({ keepAlive: true });
    const a = await f.run(claude("one"));
    const b = await f.run(claude("two", { sessionId: a.sessionId }));
    expect(spawns()).toHaveLength(1);
    expect(b.text).toBe(`two#2@${spawns()[0]!.pid}`);
    expect(b.sessionId).toBe(a.sessionId);
    expect(f.sessions()).toMatchObject([{ provider: "claude", sessionId: a.sessionId, busy: false, steer: false }]);
  });

  it("keeps the process when the consumer stops at done", async () => {
    const f = make({ keepAlive: true });
    let sessionId: string | undefined;
    for await (const e of f.stream(claude("one"))) {
      if (e.type === "session") sessionId = e.sessionId;
      if (e.type === "done") break;
    }
    await f.run(claude("two", { sessionId }));
    expect(spawns()).toHaveLength(1);
  });

  it("starts a new process and resumes when the settings differ", async () => {
    const f = make({ keepAlive: true });
    const a = await f.run(claude("one"));
    const first = spawns()[0]!.pid;
    const b = await f.run(claude("two", { sessionId: a.sessionId, system: "Be brief." }));
    expect(spawns()).toHaveLength(2);
    const second = spawns()[1]!;
    expect(second.args).toEqual(expect.arrayContaining(["--resume", a.sessionId!]));
    expect(b.text).toBe(`two#1@${second.pid}`);
    expect(await waitFor(() => !alive(first))).toBe(true);
    expect(f.sessions()).toHaveLength(1);
  });

  it("does not reuse a turn without a session id", async () => {
    const f = make({ keepAlive: true });
    await f.run(claude("one"));
    await f.run(claude("two"));
    expect(spawns()).toHaveLength(2);
    expect(f.sessions()).toHaveLength(2);
  });

  it("closes a session after idleMs", async () => {
    const f = make({ keepAlive: true, idleMs: 50 });
    await f.run(claude("one"));
    const pid = spawns()[0]!.pid;
    expect(f.sessions()).toHaveLength(1);
    expect(await waitFor(() => f.sessions().length === 0 && !alive(pid))).toBe(true);
  });

  it("closes the least recently used idle session over max", async () => {
    const f = make({ keepAlive: true, max: 1 });
    const a = await f.run(claude("one"));
    const b = await f.run(claude("two"));
    expect(f.sessions().map((s) => s.sessionId)).toEqual([b.sessionId]);
    expect(await waitFor(() => !alive(spawns()[0]!.pid))).toBe(true);
    // The closed one resumes in a new process.
    await f.run(claude("three", { sessionId: a.sessionId }));
    expect(spawns()).toHaveLength(3);
  });

  it("kills and drops the process when a turn is aborted", async () => {
    const f = make({ keepAlive: true });
    const a = await f.run(claude("one"));
    const pid = spawns()[0]!.pid;
    const controller = new AbortController();
    const events: FunnelEvent[] = [];
    for await (const e of f.stream(claude("slow", { sessionId: a.sessionId, signal: controller.signal }))) {
      events.push(e);
      if (e.type === "session") controller.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "cancelled" });
    expect(f.sessions()).toEqual([]);
    expect(await waitFor(() => !alive(pid))).toBe(true);
    const c = await f.run(claude("three", { sessionId: a.sessionId }));
    expect(spawns()).toHaveLength(2);
    expect(c.text).toMatch(/^three#1@/);
  });

  it("kills the process when the consumer leaves mid-turn", async () => {
    const f = make({ keepAlive: true });
    for await (const e of f.stream(claude("slow"))) if (e.type === "session") break;
    expect(f.sessions()).toEqual([]);
    expect(await waitFor(() => !alive(spawns()[0]!.pid))).toBe(true);
  });

  it("refuses steer with unsupported", async () => {
    const f = make({ keepAlive: true });
    const a = await f.run(claude("one"));
    await expect(f.steer(a.sessionId!, "more")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("closeSession and close stop the processes", async () => {
    const f = make({ keepAlive: true });
    const a = await f.run(claude("one"));
    await f.run(claude("two"));
    expect(f.closeSession(a.sessionId!)).toBe(true);
    expect(f.closeSession(a.sessionId!)).toBe(false);
    expect(f.sessions()).toHaveLength(1);
    f.close();
    expect(f.sessions()).toEqual([]);
    expect(await waitFor(() => spawns().every((s) => !alive(s.pid)))).toBe(true);
  });

  it("runs a second turn on a busy session in its own process", async () => {
    const f = make({ keepAlive: true });
    const a = await f.run(claude("one"));
    const controller = new AbortController();
    const slow = f.stream(claude("slow", { sessionId: a.sessionId, signal: controller.signal }));
    const it = slow[Symbol.asyncIterator]();
    await it.next();
    const b = await f.run(claude("two", { sessionId: a.sessionId }));
    expect(spawns()).toHaveLength(2);
    expect(b.text).toMatch(/^two#1@/);
    controller.abort();
    while (!(await it.next()).done) {
      /* drain */
    }
  });
});

describe("approvals on a live session", () => {
  it("asks the current turn's onApproval (claude)", async () => {
    const f = make({ keepAlive: true });
    const first: string[] = [];
    const a = await f.run(claude("one", { onApproval: (r) => (first.push(r.tool), "deny") }));
    const second: string[] = [];
    const b = await f.run(claude("ask", { sessionId: a.sessionId, onApproval: (r) => (second.push(r.tool), "allow") }));
    expect(spawns()).toHaveLength(1);
    expect(first).toEqual([]);
    expect(second).toEqual(["Bash"]);
    expect(b.text).toBe("approval:allow#2");
  });

  it("asks the current turn's onApproval (codex)", async () => {
    const f = make({ keepAlive: true });
    const sel = { provider: "codex", model: "m", cwd: tmpdir(), access: "supervised" } as const;
    const a = await f.run({ selection: sel, prompt: "one", onApproval: () => "allow" });
    const asked: string[] = [];
    const b = await f.run({ selection: sel, prompt: "ask", sessionId: a.sessionId, onApproval: (r) => (asked.push(r.tool), "deny") });
    expect(spawns()).toHaveLength(1);
    expect(asked).toEqual(["command"]);
    expect(b.text).toBe("approval:decline");
  });
});

describe("codex live sessions", () => {
  it("runs the next turn on the same app-server and thread", async () => {
    const f = make({ keepAlive: true });
    const a = await f.run(codex("one"));
    const b = await f.run(codex("two", { sessionId: a.sessionId }));
    expect(spawns()).toHaveLength(1);
    expect(b.text).toBe(`two#2@${spawns()[0]!.pid}`);
    expect(b.sessionId).toBe(a.sessionId);
    const methods = entries().flatMap((e) => (e.method ? [e.method] : []));
    expect(methods.filter((m) => m === "thread/start")).toHaveLength(1);
    expect(methods.filter((m) => m === "turn/start")).toHaveLength(2);
    expect(f.sessions()).toMatchObject([{ provider: "codex", sessionId: a.sessionId, steer: true }]);
  });

  it("steers a running turn with turn/steer", async () => {
    const f = make({ keepAlive: true });
    const a = await f.run(codex("one"));
    const s = f.stream(codex("slow", { sessionId: a.sessionId }));
    const done = (async () => {
      for await (const e of s) if (e.type === "session") await f.steer(a.sessionId!, "and more");
      return s.result;
    })();
    const r = await done;
    expect(r.text).toBe("slow+and more");
    const steer = entries().find((e) => e.method === "turn/steer")!;
    expect(steer.params).toMatchObject({ threadId: a.sessionId, expectedTurnId: "turn-2", input: [{ type: "text", text: "and more" }] });
    expect(f.sessions()).toHaveLength(1);
  });

  it("refuses steer when no turn runs", async () => {
    const f = make({ keepAlive: true });
    const a = await f.run(codex("one"));
    await expect(f.steer(a.sessionId!, "more")).rejects.toMatchObject({ code: "invalid-selection" });
    await expect(f.steer("nope", "more")).rejects.toMatchObject({ code: "invalid-selection" });
  });

  it("interrupts, then drops the app-server when a turn is aborted", async () => {
    const f = make({ keepAlive: true });
    const a = await f.run(codex("one"));
    const pid = spawns()[0]!.pid;
    const controller = new AbortController();
    const r = f.stream(codex("slow", { sessionId: a.sessionId, signal: controller.signal }));
    for await (const e of r) if (e.type === "session") setTimeout(() => controller.abort(), 20);
    expect((await r.result).finishReason).toBe("cancelled");
    expect(entries().some((e) => e.method === "turn/interrupt")).toBe(true);
    expect(f.sessions()).toEqual([]);
    expect(await waitFor(() => !alive(pid))).toBe(true);
    const c = await f.run(codex("three", { sessionId: a.sessionId }));
    expect(c.text).toMatch(/^three#1@/);
    expect(entries().some((e) => e.method === "thread/resume" && e.params.threadId === a.sessionId)).toBe(true);
  });

  it("drops an app-server whose thread failed to start", async () => {
    const f = make({ keepAlive: true });
    await expect(f.run(codex("one", { sessionId: "missing" }))).rejects.toThrow("no rollout found");
    expect(f.sessions()).toEqual([]);
    expect(await waitFor(() => !alive(spawns()[0]!.pid))).toBe(true);
  });

  it("starts a new app-server when the model differs", async () => {
    const f = make({ keepAlive: true });
    const a = await f.run(codex("one"));
    await f.run({ ...codex("two", { sessionId: a.sessionId }), selection: { provider: "codex", model: "other", cwd: tmpdir(), access: "auto" } });
    expect(spawns()).toHaveLength(2);
    expect(entries().find((e) => e.method === "thread/resume")?.params).toMatchObject({ threadId: a.sessionId, model: "other" });
  });
});

describe("fingerprint", () => {
  it("ignores the prompt and changes with anything the process starts with", () => {
    const base = claude("a");
    expect(fingerprint(claude("b"))).toBe(fingerprint(base));
    expect(fingerprint(claude("b", { sessionId: "x" }))).toBe(fingerprint(base));
    expect(fingerprint(claude("a", { env: { B: "1", A: "2" } }))).toBe(fingerprint(claude("a", { env: { A: "2", B: "1" } })));
    for (const other of [
      claude("a", { system: "s" }),
      claude("a", { responseSchema: { schema: { type: "object" } } }),
      claude("a", { env: { A: "1" } }),
      claude("a", { onApproval: () => "allow" }),
      { ...base, selection: { ...base.selection, effort: "high" } },
      { ...base, selection: { ...base.selection, access: "full" as const } },
      { ...base, selection: { ...base.selection, cwd: "/" } },
    ]) {
      expect(fingerprint(other)).not.toBe(fingerprint(base));
    }
  });
});
