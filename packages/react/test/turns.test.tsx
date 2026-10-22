import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FunnelClient, RunEvent, Selection } from "cli-funnel/client";
import { useRun } from "../src/index.js";
import { stream } from "./stream.js";

afterEach(cleanup);

const clientFor = (...streams: ReturnType<typeof stream<RunEvent>>[]) => ({ run: vi.fn(() => streams.shift()!.gen), approve: vi.fn() }) as unknown as FunnelClient;
const SEL: Selection = { provider: "claude", model: "claude-1", cwd: "/work", access: "full" };

describe("useRun turns", () => {
  it("keeps one turn per send, each with the selection it was sent with", async () => {
    const a = stream<RunEvent>();
    const b = stream<RunEvent>();
    const { result } = (() => { const client = clientFor(a, b); return renderHook(() => useRun(client, { keepTranscript: true })); })();

    const selection = { ...SEL };
    act(() => void result.current.send("one", selection));
    selection.model = "claude-2";
    act(() => {
      a.push({ type: "text.delta", text: "first" });
      a.push({ type: "done", text: "", finishReason: "stop" });
      a.end();
    });
    await waitFor(() => expect(result.current.status).toBe("done"));

    act(() => void result.current.send("two", selection));
    act(() => {
      b.push({ type: "tool.start", id: "t1", name: "Bash", input: { command: "ls" } });
      b.push({ type: "text.delta", text: "second" });
    });
    await waitFor(() => expect(result.current.turns[1]?.text).toBe("second"));

    const [first, second] = result.current.turns;
    expect(result.current.turns).toHaveLength(2);
    expect(first).toMatchObject({ prompt: "one", status: "done", text: "first", selection: SEL, finishReason: "stop" });
    expect(second).toMatchObject({ prompt: "two", status: "running", selection: { model: "claude-2" } });
    expect(second!.toolCalls).toMatchObject([{ name: "Bash", running: true }]);
  });

  it("closes a turn that a second send superseded", async () => {
    const a = stream<RunEvent>();
    const b = stream<RunEvent>();
    const { result } = (() => { const client = clientFor(a, b); return renderHook(() => useRun(client, { keepTranscript: true })); })();

    act(() => void result.current.send("one", SEL));
    act(() => a.push({ type: "text.delta", text: "half" }));
    await waitFor(() => expect(result.current.turns[0]?.text).toBe("half"));
    act(() => void result.current.send("two", SEL));
    act(() => a.push({ type: "text.delta", text: " late" }));
    await act(async () => {
      a.end();
    });

    await waitFor(() => expect(result.current.turns[0]?.status).toBe("done"));
    expect(result.current.turns[0]).toMatchObject({ text: "half", finishReason: "cancelled" });
    expect(result.current.turns[1]?.status).toBe("running");
  });

  it("holds only the latest run without keepTranscript", async () => {
    const a = stream<RunEvent>();
    const b = stream<RunEvent>();
    const { result } = (() => { const client = clientFor(a, b); return renderHook(() => useRun(client)); })();

    act(() => void result.current.send("one", SEL));
    act(() => void result.current.send("two", SEL));
    expect(result.current.turns.map((t) => t.prompt)).toEqual(["two"]);
  });

  it("clears the transcript on newConversation()", () => {
    const a = stream<RunEvent>();
    const { result } = (() => { const client = clientFor(a); return renderHook(() => useRun(client, { keepTranscript: true })); })();

    act(() => void result.current.send("one", SEL));
    expect(result.current.turns).toHaveLength(1);
    act(() => result.current.newConversation());
    expect(result.current.turns).toEqual([]);
  });

  it("reports a failed stream on the turn", async () => {
    const client = { run: vi.fn(async function* () { throw new Error("network down"); }) } as unknown as FunnelClient;
    const { result } = renderHook(() => useRun(client, { keepTranscript: true }));

    await act(() => result.current.send("one", SEL));
    expect(result.current.turns[0]).toMatchObject({ status: "error", error: "network down", finishReason: "error" });
  });

  it("parses the answer as JSON into result.structured when a schema was set and the provider sent none", async () => {
    const a = stream<RunEvent>();
    const { result } = (() => { const client = clientFor(a); return renderHook(() => useRun(client, { keepTranscript: true })); })();

    act(() => void result.current.send("one", SEL, { responseSchema: { schema: { type: "object" } } }));
    act(() => {
      a.push({ type: "text.delta", text: '{"ok":true}' });
      a.push({ type: "done", text: "", finishReason: "stop" });
      a.end();
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.turns[0]?.structured).toEqual({ ok: true });
    expect(result.current.result.structured).toEqual({ ok: true });
  });
});
