import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFunnel, type Funnel } from "../src/funnel.js";
import { claudeTurn } from "../src/providers/claude/index.js";
import { Steers } from "../src/providers/claude/live.js";
import { newClaudeTrack } from "../src/providers/claude/parser.js";
import type { FunnelEvent, RunInput } from "../src/types.js";
import { fakeNodeCli } from "./fake-cli.js";

// The uuid the recorded fixtures carry for the steer message. The fake CLI swaps in the uuid it received.
const STEER = "00000000-0000-4000-8000-0000000000aa";
const fixtureLines = (name: string) => readFileSync(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url), "utf8").split("\n").filter(Boolean);

// A fake `claude -p --input-format stream-json` that replays the steer fixtures recorded from Claude Code 2.1.319.
// The prompt picks the case:
//   fold   the recorded steer during tool calls: queued, then taken into the turn before its result
//   fold2  the same with two steers, both listed in the one result
//   late   the recorded steer while the model only writes text: the result comes first, then a turn of its own
//   race   the steer reaches the CLI just after it printed the result
//   drop   the steer is removed from the queue after the result, so no turn answers it
//   fail   the turn fails while the steer is queued, and the CLI would answer it next
//   slow   init only, then nothing
//   held   the steer is queued and a result with 3 input and 7 output tokens follows, then nothing
//   heldcrash  the same, then the CLI exits with code 1
//   crash  the CLI exits with code 1 right after init, with no steer
// Any other prompt is answered at once with "<prompt>#<n>". Every stdin line is logged.
const FAKE = `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.319 (Claude Code)"); process.exit(0); }
const STEER = ${JSON.stringify(STEER)};
const read = (name) => fs.readFileSync(require("node:path").join(process.env.FAKE_FIXTURES, name + ".ndjson"), "utf8").split("\\n").filter(Boolean);
const fold = read("steer-fold");
const late = read("steer-late");
const init = JSON.parse(fold[0]);
const sid = init.session_id;
const out = (line) => process.stdout.write((typeof line === "string" ? line : JSON.stringify(line)) + "\\n");
const lifecycle = (uuid, state) => out({ type: "command_lifecycle", command_uuid: uuid, state, uuid: "00000000-0000-4000-8000-0000000000ff", session_id: sid });
const result = (text, extra = {}) => out({ type: "result", subtype: "success", is_error: false, result: text, session_id: sid, usage: { input_tokens: 1, output_tokens: 1 }, ...extra });
const isQueued = (l) => l.includes('"state":"queued"');
let n = 0;
let scenario;
let steers = [];
const want = { fold: 1, fold2: 2, late: 1, race: 1, drop: 1, fail: 1, held: 1, heldcrash: 1 };
function onSteer(uuid) {
  steers.push(uuid);
  if (scenario === "slow") return lifecycle(uuid, "queued");
  if (steers.length < want[scenario]) return lifecycle(uuid, "queued");
  if (scenario === "fold" || scenario === "fold2") {
    lifecycle(uuid, "queued");
    const rest = fold.slice(fold.findIndex(isQueued) + 1);
    for (const l of rest) {
      if (l.includes(STEER) && l.includes('"command_lifecycle"')) {
        const state = JSON.parse(l).state;
        for (const u of steers) lifecycle(u, state);
        continue;
      }
      if (l.includes('"type":"result"')) {
        out({ ...JSON.parse(l), user_message_uuid: steers.at(-1), user_message_uuids: steers });
        continue;
      }
      out(l);
    }
  }
  if (scenario === "late") for (const l of late.slice(late.findIndex(isQueued))) out(l.replaceAll(STEER, uuid));
  if (scenario === "race") {
    const rest = late.slice(late.findIndex(isQueued) + 1);
    const r = rest.findIndex((l) => l.includes('"type":"result"'));
    for (const l of rest.slice(0, r + 1)) out(l);
    out(late[late.findIndex(isQueued)].replaceAll(STEER, uuid));
    for (const l of rest.slice(r + 1)) out(l.replaceAll(STEER, uuid));
  }
  // Claude Code reports the end of a message that started a turn of its own after that turn's result.
  if (scenario === "late" || scenario === "race") lifecycle(uuid, "completed");
  if (scenario === "drop") {
    lifecycle(uuid, "queued");
    result("first answer");
    lifecycle(uuid, "cancelled");
  }
  if (scenario === "held" || scenario === "heldcrash") {
    lifecycle(uuid, "queued");
    result("first answer", { usage: { input_tokens: 3, output_tokens: 7 } });
    // Tells the test the result is on the pipe.
    fs.writeFileSync(process.env.FAKE_LOG + ".printed", "1");
    if (scenario === "heldcrash") process.stdout.write("", () => process.exit(1));
  }
  if (scenario === "fail") {
    lifecycle(uuid, "queued");
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", session_id: sid });
    lifecycle(uuid, "started");
    out(init);
    result("answer to the steer", { user_message_uuids: [uuid] });
  }
  scenario = undefined;
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, line: m }) + "\\n");
    if (m.type !== "user") continue;
    if (m.uuid) { onSteer(m.uuid); continue; }
    n++;
    const text = m.message.content;
    steers = [];
    if (text === "crash") { out(init); process.stdout.write("", () => process.exit(1)); continue; }
    if (text in want || text === "slow") {
      scenario = text;
      const source = text === "late" || text === "race" || text === "drop" || text === "fail" ? late : fold;
      if (text === "drop" || text === "fail" || text === "slow" || text === "held" || text === "heldcrash") { out(init); continue; }
      for (const l of source.slice(0, source.findIndex(isQueued))) out(l);
      continue;
    }
    out(init);
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text + "#" + n } }, session_id: sid });
    result(text + "#" + n);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let log: string;
let funnel: Funnel | undefined;
const entries = () =>
  existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { pid: number; line: Record<string, any> })
    : [];
const pids = () => [...new Set(entries().map((e) => e.pid))];
const steerLines = () => entries().filter((e) => e.line.uuid).map((e) => e.line);

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

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "cf-steer-"));
  log = join(dir, "log");
  process.env.FAKE_LOG = log;
  process.env.FAKE_FIXTURES = fileURLToPath(new URL("./fixtures/claude/", import.meta.url));
  process.env.CLI_FUNNEL_CLAUDE_BIN = fakeNodeCli(join(dir, "claude"), FAKE);
});

afterEach(() => {
  funnel?.close();
  funnel = undefined;
  delete process.env.CLI_FUNNEL_CLAUDE_BIN;
  delete process.env.FAKE_LOG;
  delete process.env.FAKE_FIXTURES;
});

const claude = (prompt: string, extra: Partial<RunInput> = {}): RunInput => ({
  selection: { provider: "claude", model: "m", cwd: tmpdir(), access: "auto" },
  prompt,
  ...extra,
});

/** Opens a live session with one plain turn and returns the funnel and the session id. */
async function open(): Promise<{ f: Funnel; sessionId: string }> {
  funnel = createFunnel({ allowUnlistedModels: true, sessions: { keepAlive: true } });
  const first = await funnel.run(claude("hello"));
  return { f: funnel, sessionId: first.sessionId! };
}

/** Streams one turn, calls `act` on the first event `when` matches, and returns every event but deltas and raw. */
async function turn(f: Funnel, input: RunInput, when: (e: FunnelEvent) => boolean, act: () => Promise<void>): Promise<FunnelEvent[]> {
  const events: FunnelEvent[] = [];
  let acted = false;
  for await (const e of f.stream(input)) {
    if (e.type !== "text.delta") events.push(e);
    if (!acted && when(e)) {
      acted = true;
      await act();
    }
  }
  return events;
}

/** The next turn on the same session runs on the same process and sees nothing left over from the last one. */
async function expectCleanNextTurn(f: Funnel, sessionId: string, pid: number) {
  const events: FunnelEvent[] = [];
  for await (const e of f.stream(claude("next", { sessionId }))) events.push(e);
  expect(events.map((e) => e.type)).toEqual(["session", "text.delta", "usage", "done"]);
  expect(events.at(-1)).toMatchObject({ type: "done", text: expect.stringMatching(/^next#\d+$/) });
  expect(pids()).toEqual([pid]);
}

const types = (events: FunnelEvent[]) => events.map((e) => e.type);

describe("claude steer, recorded fixtures through claudeTurn", () => {
  const replay = async (name: string) => {
    const steers = new Steers();
    steers.add(STEER);
    const state = { finished: false };
    const proc = { write: () => {}, exited: new Promise<number>(() => {}), stderr: () => "", onStderr: () => () => {} };
    async function* lines() {
      for (const l of fixtureLines(name)) yield JSON.parse(l);
    }
    const events: FunnelEvent[] = [];
    for await (const e of claudeTurn(proc, lines(), claude("x"), {}, state, newClaudeTrack(), undefined, steers)) events.push(e);
    return { events, state, steers };
  };

  it("ends a turn that took the steer in at its one result", async () => {
    const { events, state, steers } = await replay("steer-fold");
    expect(events.filter((e) => e.type === "done")).toEqual([{ type: "done", text: "DONE. PINEAPPLE.", finishReason: "stop" }]);
    expect(events.filter((e) => e.type === "tool.start")).toHaveLength(3);
    expect(state.finished).toBe(true);
    expect(steers.idle).toBe(true);
  });

  it("goes on through the turn that answers a late steer, with one session, one usage and one done", async () => {
    const { events, state, steers } = await replay("steer-late");
    expect(types(events).filter((t) => t !== "text.delta")).toEqual(["session", "usage", "done"]);
    // Recorded usage: 243 output tokens in the first result and 43 in the second.
    expect(events.find((e) => e.type === "usage")).toMatchObject({ usage: { outputTokens: 286 } });
    expect(events.at(-1)).toEqual({ type: "done", text: "MANGO.", finishReason: "stop" });
    expect(state.finished).toBe(true);
    expect(steers.idle).toBe(true);
  });

  it("keeps a denial from the first result when the turn goes on", async () => {
    const steers = new Steers();
    steers.add(STEER);
    const proc = { write: () => {}, exited: new Promise<number>(() => {}), stderr: () => "", onStderr: () => () => {} };
    const denials = [{ tool_name: "Bash", tool_use_id: "t1", tool_input: {} }];
    async function* lines() {
      yield { type: "system", subtype: "init", session_id: "s", capabilities: ["msg_lifecycle_v1"] };
      yield { type: "result", subtype: "success", is_error: false, result: "first", permission_denials: denials };
      yield { type: "command_lifecycle", command_uuid: STEER, state: "started" };
      yield { type: "result", subtype: "success", is_error: false, result: "second", permission_denials: [], user_message_uuids: [STEER] };
    }
    const events: FunnelEvent[] = [];
    for await (const e of claudeTurn(proc, lines(), claude("x"), {}, { finished: false }, newClaudeTrack(), undefined, steers)) events.push(e);
    expect(events.filter((e) => e.type === "done")).toEqual([{ type: "done", text: "second", finishReason: "denied" }]);
  });
});

describe("claude steer, results held back through claudeTurn", () => {
  const proc = { write: () => {}, exited: new Promise<number>(() => {}), stderr: () => "", onStderr: () => () => {} };
  const INIT = { type: "system", subtype: "init", session_id: "s", capabilities: ["msg_lifecycle_v1"] };
  const result = (text: string, extra: Record<string, unknown> = {}) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra,
  });
  const drain = async (lines: () => AsyncGenerator<unknown>, steers: Steers, track = newClaudeTrack()) => {
    const events: FunnelEvent[] = [];
    for await (const e of claudeTurn(proc, lines(), claude("x"), {}, { finished: false }, track, undefined, steers)) events.push(e);
    return events;
  };

  it("reports the usage of a held result when the CLI exits before the next one", async () => {
    const steers = new Steers();
    steers.add(STEER);
    const events = await drain(async function* () {
      yield INIT;
      yield result("first", { usage: { input_tokens: 3, output_tokens: 7 } });
    }, steers);
    expect(events.filter((e) => e.type === "usage")).toMatchObject([{ type: "usage", usage: { inputTokens: 3, outputTokens: 7 } }]);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("keeps a denial when the last queued steer is cancelled", async () => {
    const [a, b] = [STEER, "00000000-0000-4000-8000-0000000000bb"];
    const steers = new Steers();
    steers.add(a);
    steers.add(b);
    const events = await drain(async function* () {
      yield INIT;
      yield result("first", { permission_denials: [{ tool_name: "Bash", tool_use_id: "t1", tool_input: {} }] });
      yield { type: "command_lifecycle", command_uuid: a, state: "started" };
      yield result("second", { permission_denials: [], user_message_uuids: [a] });
      yield { type: "command_lifecycle", command_uuid: b, state: "cancelled" };
    }, steers);
    expect(events.filter((e) => e.type === "done")).toEqual([{ type: "done", text: "second", finishReason: "denied" }]);
  });

  it("keeps the rest of a stderr warning when a stream notice comes in the middle", async () => {
    const track = newClaudeTrack();
    const events = await drain(async function* () {
      yield INIT;
      track.notices.push("Warning: sandbox disabled");
      yield { type: "system", subtype: "notification", priority: "high", text: "Fast mode disabled" };
      track.notices.push("  Commands will run WITHOUT sandboxing.");
      yield result("done");
    }, new Steers(), track);
    expect(events.filter((e) => e.type === "warning")).toEqual([
      { type: "warning", message: "Fast mode disabled" },
      { type: "warning", message: "sandbox disabled Commands will run WITHOUT sandboxing." },
    ]);
  });
});

describe("claude live session steer", () => {
  it("is offered when the CLI reports the message lifecycle", async () => {
    const { f, sessionId } = await open();
    expect(f.sessions()).toMatchObject([{ provider: "claude", sessionId, steer: true }]);
  });

  it("adds a message that the running turn takes in", async () => {
    const { f, sessionId } = await open();
    const events = await turn(f, claude("fold", { sessionId }), (e) => e.type === "tool.start", () => f.steer(sessionId, "Also say PINEAPPLE."));
    expect(steerLines()).toEqual([{ type: "user", uuid: expect.any(String), priority: "next", message: { role: "user", content: "Also say PINEAPPLE." } }]);
    expect(events.filter((e) => e.type === "done")).toEqual([{ type: "done", text: "DONE. PINEAPPLE.", finishReason: "stop" }]);
    expect(types(events).filter((t) => t === "session")).toHaveLength(1);
    await expectCleanNextTurn(f, sessionId, pids()[0]!);
  });

  it("takes two steers in one turn", async () => {
    const { f, sessionId } = await open();
    const events = await turn(f, claude("fold2", { sessionId }), (e) => e.type === "tool.start", async () => {
      await f.steer(sessionId, "one");
      await f.steer(sessionId, "two");
    });
    expect(steerLines().map((l) => l.message.content)).toEqual(["one", "two"]);
    expect(new Set(steerLines().map((l) => l.uuid)).size).toBe(2);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    await expectCleanNextTurn(f, sessionId, pids()[0]!);
  });

  it("keeps the turn open through the answer to a steer that came after the turn's work", async () => {
    const { f, sessionId } = await open();
    const events = await turn(f, claude("late", { sessionId }), (e) => e.type === "session", () => f.steer(sessionId, "Now say MANGO."));
    expect(types(events)).toEqual(["session", "usage", "done"]);
    expect(events.at(-1)).toEqual({ type: "done", text: "MANGO.", finishReason: "stop" });
    await expectCleanNextTurn(f, sessionId, pids()[0]!);
  });

  it("keeps the turn open when the steer reaches the CLI just after its result", async () => {
    const { f, sessionId } = await open();
    const events = await turn(f, claude("race", { sessionId }), (e) => e.type === "session", () => f.steer(sessionId, "Now say MANGO."));
    expect(types(events)).toEqual(["session", "usage", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", text: "MANGO." });
    await expectCleanNextTurn(f, sessionId, pids()[0]!);
  });

  it("ends with the first answer when the steer is dropped from the queue", async () => {
    const { f, sessionId } = await open();
    const events = await turn(f, claude("drop", { sessionId }), (e) => e.type === "session", () => f.steer(sessionId, "never answered"));
    expect(types(events)).toEqual(["session", "usage", "done"]);
    expect(events.at(-1)).toEqual({ type: "done", text: "first answer", finishReason: "stop" });
    await expectCleanNextTurn(f, sessionId, pids()[0]!);
  });

  it("stops the process when the turn fails with a steer still queued", async () => {
    const { f, sessionId } = await open();
    const pid = pids()[0]!;
    const events = await turn(f, claude("fail", { sessionId }), (e) => e.type === "session", () => f.steer(sessionId, "queued"));
    expect(events.at(-1)).toMatchObject({ type: "error", message: "boom" });
    expect(await waitFor(() => !alive(pid))).toBe(true);
    expect(f.sessions()).toEqual([]);
    // The next turn resumes in a new process, and the answer to the queued steer never reaches it.
    const next = await f.run(claude("next", { sessionId }));
    expect(next.text).toBe("next#1");
    expect(pids()).toHaveLength(2);
  });

  it("refuses a steer when no turn is running", async () => {
    const { f, sessionId } = await open();
    await expect(f.steer(sessionId, "more")).rejects.toMatchObject({ code: "invalid-selection" });
    expect(steerLines()).toEqual([]);
  });

  it("refuses a steer once the turn reached its end", async () => {
    const { f, sessionId } = await open();
    let refused: unknown;
    for await (const e of f.stream(claude("again", { sessionId }))) {
      if (e.type === "usage") refused = await f.steer(sessionId, "too late").catch((err: unknown) => err);
    }
    expect(refused).toMatchObject({ code: "invalid-selection" });
    expect(steerLines()).toEqual([]);
    await expectCleanNextTurn(f, sessionId, pids()[0]!);
  });

  it("stops the process when a turn is aborted after a steer", async () => {
    const { f, sessionId } = await open();
    const pid = pids()[0]!;
    const controller = new AbortController();
    const events = await turn(f, claude("slow", { sessionId, signal: controller.signal }), (e) => e.type === "session", async () => {
      await f.steer(sessionId, "queued");
      controller.abort();
    });
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "cancelled" });
    expect(await waitFor(() => !alive(pid))).toBe(true);
    const next = await f.run(claude("next", { sessionId }));
    expect(next.text).toBe("next#1");
  });

  it("reports the usage of a held result when the turn is aborted", async () => {
    const { f, sessionId } = await open();
    const controller = new AbortController();
    const events = await turn(f, claude("held", { sessionId, signal: controller.signal }), (e) => e.type === "session", async () => {
      await f.steer(sessionId, "queued");
      expect(await waitFor(() => existsSync(`${log}.printed`))).toBe(true);
      // The result is on the pipe. Give the reader a moment to take it before the abort.
      await new Promise((r) => setTimeout(r, 150));
      controller.abort();
    });
    expect(events.filter((e) => e.type === "usage")).toMatchObject([{ type: "usage", usage: { inputTokens: 3, outputTokens: 7 } }]);
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "cancelled" });
  });

  it("reports an error, with the held usage, when the CLI crashes while a result is held", async () => {
    const { f, sessionId } = await open();
    const events = await turn(f, claude("heldcrash", { sessionId }), (e) => e.type === "session", () => f.steer(sessionId, "queued"));
    expect(events.filter((e) => e.type === "usage")).toMatchObject([{ type: "usage", usage: { inputTokens: 3, outputTokens: 7 } }]);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cli-failed", message: expect.stringContaining("(1)") });
  });

  it("reports an error when the CLI crashes in a turn with no steer", async () => {
    const { f, sessionId } = await open();
    const events = await turn(f, claude("crash", { sessionId }), () => false, async () => {});
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cli-failed" });
  });
});
