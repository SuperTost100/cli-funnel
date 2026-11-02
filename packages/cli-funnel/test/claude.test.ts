import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArgs, claudeProvider } from "../src/providers/claude/index.js";
import { newClaudeTrack, parseClaudeMessage } from "../src/providers/claude/parser.js";
import { collect } from "./helpers.js";
import type { FunnelEvent, RunInput, Selection } from "../src/types.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => parseClaudeMessage(JSON.parse(l)));

const sel = (over: Partial<Selection> = {}): Selection => ({
  provider: "claude", model: "claude-haiku-4-5-20251001", cwd: "/tmp", access: "accept-edits", ...over,
});

describe("claude parser", () => {
  it("maps a plain text run", () => {
    const ev = fixture("text");
    expect(ev[0]).toMatchObject({ type: "session", model: "claude-haiku-4-5-20251001" });
    expect(ev.some((e) => e.type === "text.delta")).toBe(true);
    expect(ev.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
    expect(ev.find((e) => e.type === "usage")).toBeTruthy();
  });

  it("maps tool calls and results", () => {
    const ev = fixture("tool-allow");
    const start = ev.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ name: "Write", input: { content: "hi" } });
    const end = ev.find((e) => e.type === "tool.end");
    expect(end).toMatchObject({ id: (start as any).id });
    expect((end as any).error).toBeUndefined();
  });

  it("reports a denied tool", () => {
    const ev = fixture("tool-deny");
    expect(ev.find((e) => e.type === "tool.end")).toMatchObject({ error: "User denied" });
    expect(ev.at(-1)).toMatchObject({ type: "done", finishReason: "denied" });
  });

  it("turns an is_error result into an error event", () => {
    const ev = fixture("error-credits");
    expect(ev.at(-1)).toMatchObject({ type: "error", code: "429" });
  });

  // Recorded from claude 2.1.300 with --forward-subagent-text and one subagent call.
  const subagentRun = (forward: boolean) =>
    readFileSync(new URL("./fixtures/claude/subagent-text.ndjson", import.meta.url), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => parseClaudeMessage(JSON.parse(l), { text: forward }));

  it("drops subagent messages by default", () => {
    const ev = subagentRun(false);
    expect(ev.some((e) => e.type === "subagent.text")).toBe(false);
    expect(ev.filter((e) => e.type === "text.delta").map((e) => (e as { text: string }).text).join("")).toBe("17 plus 25 equals 42.");
    expect(ev.at(-1)).toMatchObject({ type: "done", text: "17 plus 25 equals 42." });
  });

  it("forwards a subagent's text with the id of the call that started it", () => {
    const ev = subagentRun(true);
    const call = ev.find((e) => e.type === "tool.start");
    expect(call).toMatchObject({ name: "Agent", input: { subagent_type: "calc" } });
    // The subagent's prompt and its empty thinking block are not forwarded.
    expect(ev.filter((e) => e.type === "subagent.text")).toEqual([{ type: "subagent.text", parentId: (call as { id: string }).id, text: "42", agent: "calc" }]);
    // The main thread reads the same as without the flag.
    expect(ev.filter((e) => e.type !== "subagent.text")).toEqual(subagentRun(false));
  });

  // Recorded from claude 2.1.316 without --forward-subagent-text: a background subagent that makes one Read call.
  const toolsFixture = readFileSync(new URL("./fixtures/claude/subagent-tools.ndjson", import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const toolsRun = (forward: { text?: boolean; tools?: boolean }) => {
    const track = newClaudeTrack();
    return toolsFixture.flatMap((l) => parseClaudeMessage(l, forward, track));
  };
  const AGENT_CALL = "toolu_0000000000000000000001";

  it("drops subagent tool calls unless forwardSubagentTools is on", () => {
    const off = toolsRun({});
    expect(off.some((e) => "parentId" in e)).toBe(false);
    expect(off.filter((e) => e.type === "tool.start").map((e) => (e as { name: string }).name)).toEqual(["Agent"]);
  });

  it("forwards a subagent's tool calls with the id of the call that started it", () => {
    const ev = toolsRun({ tools: true });
    const sub = ev.filter((e) => "parentId" in e);
    expect(sub).toEqual([
      { type: "tool.start", id: "toolu_0000000000000000000002", name: "Read", input: { file_path: "/home/user/project/note.txt" }, parentId: AGENT_CALL, agent: "reader" },
      { type: "tool.end", id: "toolu_0000000000000000000002", output: "1\tthe secret number is 7\n2\t", parentId: AGENT_CALL, agent: "reader" },
    ]);
    expect(ev.find((e) => e.type === "tool.start")).toMatchObject({ id: AGENT_CALL, name: "Agent" });
    // The subagent's text stays out without forwardSubagentText, and the main thread reads as before.
    expect(ev.some((e) => e.type === "subagent.text")).toBe(false);
    expect(ev.filter((e) => !("parentId" in e))).toEqual(toolsRun({}));
  });

  it("forwards text and tool calls together in the order they came", () => {
    const ev = toolsRun({ text: true, tools: true }).filter((e) => "parentId" in e);
    expect(ev.map((e) => e.type)).toEqual(["tool.start", "tool.end", "subagent.text"]);
  });

  it("keeps subagent tool calls out of the result's tool calls", async () => {
    const result = await collect(
      (async function* () {
        yield* toolsRun({ tools: true });
      })(),
      { selection: sel(), prompt: "x" },
    );
    expect(result.toolCalls.map((c) => c.name)).toEqual(["Agent"]);
    expect(result.text).toMatch(/^I've launched the reader subagent/);
  });

  it("keeps a subagent's plan and task calls out of the run's plan", () => {
    const track = newClaudeTrack();
    const from = { parent_tool_use_id: AGENT_CALL, subagent_type: "reader" };
    const todo = { type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: "a", status: "pending" }] } };
    const task = { type: "tool_use", id: "t2", name: "TaskCreate", input: { subject: "b" } };
    const ev = [
      { type: "assistant", message: { content: [todo, task] }, ...from },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "Task #1 created" }] }, tool_use_result: { task: { id: "1" } }, ...from },
    ].flatMap((l) => parseClaudeMessage(l, { tools: true }, track));
    expect(ev.map((e) => e.type)).toEqual(["tool.start", "tool.start", "tool.end"]);
    expect(track.tasks).toEqual([]);
    expect(track.taskCalls.size).toBe(0);
  });

  it("keeps the parent on a subagent call the result lists as denied", () => {
    const track = newClaudeTrack();
    const from = { parent_tool_use_id: AGENT_CALL, subagent_type: "reader" };
    const ev = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "rm x" } }] }, ...from },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "not allowed", is_error: true }] }, ...from },
      { type: "result", subtype: "success", is_error: false, result: "ok", permission_denials: [{ tool_name: "Bash", tool_use_id: "b1", tool_input: {} }] },
    ].flatMap((l) => parseClaudeMessage(l, { tools: true }, track));
    expect(ev.filter((e) => e.type === "tool.end")).toEqual([
      { type: "tool.end", id: "b1", error: "not allowed", parentId: AGENT_CALL, agent: "reader" },
      { type: "tool.end", id: "b1", error: "denied: Bash was not allowed", parentId: AGENT_CALL, agent: "reader" },
    ]);
    expect(track.subagentCalls.size).toBe(0);
  });

  it("keeps subagent text out of the result", async () => {
    const result = await collect(
      (async function* () {
        yield* subagentRun(true);
      })(),
      { selection: sel(), prompt: "x" },
    );
    expect(result.text).toBe("17 plus 25 equals 42.");
  });
});

describe("claude args", () => {
  it("maps access levels and the approval channel", () => {
    const base = { prompt: "x" };
    const sup = buildArgs({ ...base, selection: sel({ access: "supervised", effort: "low" }), onApproval: () => "allow", sessionId: "abc" });
    expect(sup).toEqual(expect.arrayContaining(["--permission-mode", "manual", "--permission-prompt-tool", "stdio", "--effort", "low", "--resume", "abc"]));
    const full = buildArgs({ ...base, selection: sel({ access: "full" }), onApproval: () => "allow" });
    expect(full).toContain("bypassPermissions");
    expect(full).not.toContain("--permission-prompt-tool");
    expect(full).not.toContain("--bare");
  });

  it("selects the 1M context variant with the [1m] suffix", () => {
    const args = (contextWindow?: number) => buildArgs({ prompt: "x", selection: sel({ model: "claude-opus-4-6", contextWindow }) });
    expect(args(1_000_000)).toEqual(expect.arrayContaining(["--model", "claude-opus-4-6[1m]"]));
    expect(args(200_000)).toEqual(expect.arrayContaining(["--model", "claude-opus-4-6"]));
    expect(args()).toEqual(expect.arrayContaining(["--model", "claude-opus-4-6"]));
  });
});

describe("claude models", () => {
  it("lists concrete ids from the manifest", async () => {
    const models = await claudeProvider.models();
    expect(models.map((m) => m.id)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-4-6", "claude-haiku-5-5", "claude-haiku-4-5-20251001"]);
    expect(models.every((m) => !m.fast)).toBe(true);
    expect(models.find((m) => m.id === "claude-opus-4-6")).toMatchObject({ contextWindows: [200_000, 1_000_000], defaultContextWindow: 200_000 });
  });
});

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1")("claude live", () => {
  it("runs, asks for approval, and resumes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cf-claude-live-"));
    const asked: string[] = [];
    const input: RunInput = {
      selection: sel({ cwd, access: "supervised" }),
      prompt: "Create hello.txt containing hi with the Write tool.",
      onApproval: (r) => (asked.push(r.tool), "allow"),
    };
    const events: FunnelEvent[] = [];
    const first = await collect((async function* () { for await (const e of claudeProvider.run(input)) { events.push(e); yield e; } })(), input);
    expect(asked).toContain("Write");
    expect(first.sessionId).toBeTruthy();
    const second = await collect(claudeProvider.run({ ...input, prompt: "Say ok.", sessionId: first.sessionId, selection: sel({ cwd, access: "accept-edits" }) }), input);
    expect(second.text.length).toBeGreaterThan(0);
  }, 120_000);
});
