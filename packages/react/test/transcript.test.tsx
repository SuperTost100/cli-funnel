import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FunnelEvent, Selection } from "cli-funnel/client";
import { FunnelTranscript } from "../src/FunnelTranscript.js";
import { applyEvent, endTurn, startTurn, type Turn } from "../src/transcript.js";

const selection: Selection = { provider: "claude", model: "claude-haiku-4-5-20251001", cwd: "/tmp/work", access: "supervised" };

const fold = (events: FunnelEvent[], turn = startTurn(1, "list files", selection)) => events.reduce(applyEvent, turn);

describe("applyEvent", () => {
  it("snapshots the selection and starts running", () => {
    const turn = startTurn(7, "hi", selection);
    expect(turn).toMatchObject({ id: 7, prompt: "hi", selection, model: selection.model, status: "running", text: "", toolCalls: [], deniedActions: [] });
  });

  it("does not share the selection object's later changes", () => {
    const mutable = { ...selection };
    const turn = startTurn(1, "hi", { ...mutable });
    mutable.model = "other";
    expect(turn.selection.model).toBe(selection.model);
  });

  it("accumulates text and takes the model and session from the session event", () => {
    const turn = fold([
      { type: "session", sessionId: "s1", model: "claude-haiku-4-5-20251001-real" },
      { type: "text.delta", text: "Hel" },
      { type: "text.delta", text: "lo" },
    ]);
    expect(turn).toMatchObject({ text: "Hello", sessionId: "s1", model: "claude-haiku-4-5-20251001-real" });
  });

  it("keeps the selected model when the session event names none", () => {
    expect(fold([{ type: "session", sessionId: "s1" }]).model).toBe(selection.model);
  });

  it("tracks a tool call from start to end", () => {
    const started = fold([{ type: "tool.start", id: "t1", name: "Bash", input: { command: "ls" } }]);
    expect(started.toolCalls).toEqual([{ id: "t1", name: "Bash", input: { command: "ls" }, running: true }]);
    const ended = applyEvent(started, { type: "tool.end", id: "t1", output: "a.txt" });
    expect(ended.toolCalls).toEqual([{ id: "t1", name: "Bash", input: { command: "ls" }, output: "a.txt", error: undefined, running: false }]);
  });

  it("records denied tool calls by name, and a failure that is not a denial stays out", () => {
    const turn = fold([
      { type: "tool.start", id: "t1", name: "Bash", input: {} },
      { type: "tool.end", id: "t1", error: "denied: Bash was not allowed" },
      { type: "tool.start", id: "t2", name: "Read", input: {} },
      { type: "tool.end", id: "t2", error: "ENOENT" },
    ]);
    expect(turn.deniedActions).toEqual(["Bash"]);
    expect(turn.toolCalls.map((c) => c.error)).toEqual(["denied: Bash was not allowed", "ENOENT"]);
  });

  it("names a denial after its error text when the tool call is unknown", () => {
    expect(fold([{ type: "tool.end", id: "gone", error: "denied: Write" }]).deniedActions).toEqual(["Write"]);
  });

  it("takes usage, structured data and the final text", () => {
    const usage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };
    const turn = fold([
      { type: "text.delta", text: "partial" },
      { type: "usage", usage },
      { type: "structured", data: { ok: true } },
      { type: "done", text: "final answer", finishReason: "stop" },
    ]);
    expect(turn).toMatchObject({ usage, structured: { ok: true }, text: "final answer", finishReason: "stop" });
  });

  it("keeps streamed text when done carries none", () => {
    expect(fold([{ type: "text.delta", text: "abc" }, { type: "done", text: "", finishReason: "stop" }]).text).toBe("abc");
  });

  it("marks the turn failed on an error event", () => {
    expect(fold([{ type: "error", message: "boom" }])).toMatchObject({ status: "error", error: "boom", finishReason: "error" });
  });

  it("ignores events that are not part of the transcript", () => {
    const turn = startTurn(1, "x", selection);
    expect(applyEvent(turn, { type: "reasoning.delta", text: "thinking" })).toBe(turn);
    expect(applyEvent(turn, { type: "approval.request", request: { id: "a", tool: "Bash", input: {} } })).toBe(turn);
  });
});

describe("endTurn", () => {
  it("finishes a running turn", () => {
    expect(endTurn(fold([{ type: "done", text: "", finishReason: "stop" }]))).toMatchObject({ status: "done", finishReason: "stop" });
  });

  it("marks a stopped run as cancelled and closes tool calls left running", () => {
    const turn = endTurn(fold([{ type: "tool.start", id: "t1", name: "Bash" }]), { aborted: true });
    expect(turn).toMatchObject({ status: "done", finishReason: "cancelled" });
    expect(turn.toolCalls[0]?.running).toBe(false);
  });

  it("keeps the first error", () => {
    const failed = fold([{ type: "error", message: "first" }]);
    expect(endTurn(failed, { error: "second" })).toMatchObject({ status: "error", error: "first" });
  });

  it("records a transport error", () => {
    expect(endTurn(startTurn(1, "x", selection), { error: "network down" })).toMatchObject({ status: "error", error: "network down", finishReason: "error" });
  });

  it("parses a JSON answer, with or without a code fence, when a schema was set", () => {
    const answer = (text: string) => endTurn(fold([{ type: "text.delta", text }, { type: "done", text: "", finishReason: "stop" }]), { responseSchema: true });
    expect(answer('{"a":1}').structured).toEqual({ a: 1 });
    expect(answer('```json\n{"a":2}\n```').structured).toEqual({ a: 2 });
    const bad = answer("not json");
    expect(bad.structured).toBeUndefined();
    expect(bad.structuredError).toMatch(/not JSON/);
  });

  it("does not parse the text without a schema, or over a provider's structured data", () => {
    const done = fold([{ type: "text.delta", text: '{"a":1}' }, { type: "done", text: "", finishReason: "stop" }]);
    expect(endTurn(done).structured).toBeUndefined();
    const native = fold([{ type: "structured", data: { native: true } }], done);
    expect(endTurn(native, { responseSchema: true }).structured).toEqual({ native: true });
  });
});

describe("FunnelTranscript", () => {
  const render = (turns: Turn[]) => renderToStaticMarkup(<FunnelTranscript turns={turns} />);

  it("renders nothing without turns", () => {
    expect(render([])).toBe("");
  });

  it("renders each turn with its prompt, collapsed tool calls and answer", () => {
    const turn = endTurn(
      fold([
        { type: "tool.start", id: "t1", name: "Bash", input: { command: "ls -la" } },
        { type: "tool.end", id: "t1", output: "a.txt" },
        { type: "text.delta", text: "One file." },
        { type: "usage", usage: { inputTokens: 1200, outputTokens: 30, totalTokens: 1230 } },
        { type: "done", text: "", finishReason: "stop" },
      ]),
    );
    const html = render([turn, { ...turn, id: 2, prompt: "again" }]);
    expect(html.match(/<article/g)).toHaveLength(2);
    expect(html).toContain("list files");
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("ls -la");
    expect(html).toContain("One file.");
    expect(html).toContain("1,200 in, 30 out");
  });

  it("escapes prompt and answer text", () => {
    const turn = endTurn(fold([{ type: "text.delta", text: "<img src=x onerror=alert(1)>" }]), {});
    expect(render([turn])).not.toContain("<img");
  });

  it("shows denied actions and a failed run", () => {
    const denied = endTurn(
      fold([
        { type: "tool.start", id: "t1", name: "Bash", input: {} },
        { type: "tool.end", id: "t1", error: "denied: Bash was not allowed" },
        { type: "done", text: "", finishReason: "denied" },
      ]),
    );
    expect(render([denied])).toContain("Not allowed: Bash.");
    expect(render([fold([{ type: "error", message: "boom" }])])).toContain("boom");
  });
});
