import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessLevel, DirListing, FunnelClient, FunnelEvent, LoginStreamEvent, ModelInfo, ProviderId, ProviderOverview, RunEvent, Selection } from "cli-funnel/client";
import { ApprovalPrompt, FunnelPicker, useAuth, useRun, useSelection } from "../src/index.js";

afterEach(cleanup);

// --- fakes -------------------------------------------------------------------------------------------------------

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

/** An async stream the test feeds by hand. */
function stream<T>() {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* gen(): AsyncGenerator<T> {
    for (;;) {
      if (queue.length) yield queue.shift()!;
      else if (closed) return;
      else await new Promise<void>((r) => (wake = r));
    }
  }
  return {
    gen: gen(),
    push(e: T) {
      queue.push(e);
      wake?.();
    },
    end() {
      closed = true;
      wake?.();
    },
  };
}

const model = (id: string, provider: ProviderId = "claude"): ModelInfo => ({ id, name: id, provider, efforts: [], contextWindows: [], fast: false, source: "manifest" });

function overview(id: ProviderId, access: AccessLevel[]): ProviderOverview {
  return {
    id,
    displayName: id,
    capabilities: { access, effort: false, contextWindow: false, fast: false, resume: true, approvals: true, images: false, system: "prompt", schema: "prompt" },
    installation: { installed: true, testedRange: { min: "1.0.0" } },
    auth: { loggedIn: true },
  };
}

const CLAUDE = overview("claude", ["accept-edits", "full"]);
const CODEX = overview("codex", ["accept-edits", "full"]);
const OLLAMA = overview("ollama", []);

function fakeClient(over: Record<string, unknown> = {}) {
  const client = {
    providers: vi.fn(async () => [CLAUDE, CODEX]),
    models: vi.fn(async (id: ProviderId) => [model(`${id}-1`, id), model(`${id}-2`, id)]),
    authStatus: vi.fn(async () => ({ loggedIn: true })),
    login: vi.fn(),
    cancelLogin: vi.fn(async () => ({ ok: true })),
    sendLoginCode: vi.fn(),
    logout: vi.fn(),
    update: vi.fn(),
    listDirs: vi.fn(),
    run: vi.fn(),
    approve: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  return client as typeof client & FunnelClient;
}

const SEL: Selection = { provider: "claude", model: "claude-1", cwd: "/work", access: "full" };

// --- useRun ------------------------------------------------------------------------------------------------------

describe("useRun", () => {
  it("aborts the previous run on a second send and sends approvals to the new run", async () => {
    const a = stream<RunEvent>();
    const b = stream<RunEvent>();
    const signals: AbortSignal[] = [];
    const streams = [a, b];
    const client = fakeClient({ run: vi.fn((_input: unknown, signal: AbortSignal) => (signals.push(signal), streams.shift()!.gen)) });
    const { result } = renderHook(() => useRun(client));

    act(() => void result.current.send("one", SEL));
    act(() => a.push({ type: "run", runId: "A" }));
    act(() => void result.current.send("two", SEL));
    expect(signals[0]!.aborted).toBe(true);

    // The aborted run keeps talking. Nothing it says may reach the state.
    act(() => {
      a.push({ type: "text.delta", text: "from A" });
      a.push({ type: "approval.request", request: { id: "ap-A", tool: "Bash", input: "ls" } });
      b.push({ type: "run", runId: "B" });
      b.push({ type: "text.delta", text: "from B" });
      b.push({ type: "approval.request", request: { id: "ap-B", tool: "Bash", input: "ls" } });
    });
    await waitFor(() => expect(result.current.approvals.map((r) => r.id)).toEqual(["ap-B"]));
    expect(result.current.text).toBe("from B");

    await act(() => result.current.approve("ap-B", "allow"));
    expect(client.approve).toHaveBeenCalledWith("B", "ap-B", "allow");
  });

  it("ignores a late session event after newConversation()", async () => {
    const a = stream<RunEvent>();
    const client = fakeClient({ run: vi.fn(() => a.gen) });
    const { result } = renderHook(() => useRun(client));

    act(() => void result.current.send("one", SEL));
    act(() => result.current.newConversation());
    act(() => a.push({ type: "session", sessionId: "old" }));
    await act(async () => {
      a.end();
    });
    expect(result.current.sessionId).toBeUndefined();
    expect(result.current.status).toBe("done");
  });

  it("keeps the approval and shows the error when approve fails", async () => {
    const a = stream<RunEvent>();
    const client = fakeClient({ run: vi.fn(() => a.gen), approve: vi.fn().mockRejectedValueOnce(new Error("network down")) });
    const { result } = renderHook(() => useRun(client));

    act(() => void result.current.send("one", SEL));
    act(() => {
      a.push({ type: "run", runId: "A" });
      a.push({ type: "approval.request", request: { id: "ap", tool: "Bash", input: "ls" } });
    });
    await waitFor(() => expect(result.current.approvals).toHaveLength(1));

    await act(() => result.current.approve("ap", "allow"));
    expect(result.current.approvals).toHaveLength(1);
    expect(result.current.error).toBe("network down");

    await act(() => result.current.approve("ap", "allow"));
    expect(result.current.approvals).toHaveLength(0);
  });

  it("aborts the run on unmount", async () => {
    const a = stream<RunEvent>();
    let signal!: AbortSignal;
    const client = fakeClient({ run: vi.fn((_input: unknown, s: AbortSignal) => ((signal = s), a.gen)) });
    const { result, unmount } = renderHook(() => useRun(client));
    act(() => void result.current.send("one", SEL));
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("cancels the run on the server and closes the stream", async () => {
    const a = stream<RunEvent>();
    let signal!: AbortSignal;
    const client = fakeClient({ run: vi.fn((_input: unknown, s: AbortSignal) => ((signal = s), a.gen)), cancelRun: vi.fn(async () => ({ ok: true })) });
    const { result } = renderHook(() => useRun(client));
    act(() => void result.current.send("one", SEL));
    act(() => a.push({ type: "run", runId: "A" }));
    await act(async () => {});
    act(() => result.current.cancel());
    expect(client.cancelRun).toHaveBeenCalledWith("A");
    expect(signal.aborted).toBe(true);
  });

  it("shows the queue position until the run starts", async () => {
    const a = stream<RunEvent>();
    const client = fakeClient({ run: vi.fn(() => a.gen) });
    const { result } = renderHook(() => useRun(client));
    act(() => void result.current.send("one", SEL));
    act(() => {
      a.push({ type: "run", runId: "A" });
      a.push({ type: "queue.position", ahead: 1 });
    });
    await waitFor(() => expect(result.current.queued).toBe(1));
    expect(result.current.turns[0]?.queued).toBe(1);
    act(() => a.push({ type: "session", sessionId: "s" }));
    await waitFor(() => expect(result.current.queued).toBeUndefined());
    expect(result.current.turns[0]?.queued).toBeUndefined();
    expect(result.current.events.map((e) => e.type)).toEqual(["session"]);
  });

  it("puts the first limit on the result and the turn", async () => {
    const a = stream<RunEvent>();
    const client = fakeClient({ run: vi.fn(() => a.gen) });
    const { result } = renderHook(() => useRun(client));
    act(() => void result.current.send("one", SEL));
    act(() => a.push({ type: "limit", kind: "quota", resetAt: "2026-10-19T09:30:00Z", detail: "Weekly limit." }));
    await waitFor(() => expect(result.current.result.limit).toEqual({ kind: "quota", resetAt: "2026-10-19T09:30:00Z", detail: "Weekly limit." }));
    expect(result.current.turns[0]?.limit).toEqual(result.current.result.limit);
  });

  it("labels the result with the selection from send time and keeps done.text, structured and denied actions", async () => {
    const a = stream<RunEvent>();
    const client = fakeClient({ run: vi.fn(() => a.gen) });
    const { result } = renderHook(() => useRun(client));

    const selection = { ...SEL };
    act(() => void result.current.send("one", selection));
    selection.provider = "codex";
    selection.model = "codex-1";

    const events: FunnelEvent[] = [
      { type: "session", sessionId: "s1", model: "claude-1-20250101" },
      { type: "text.delta", text: "partial" },
      { type: "tool.start", id: "t1", name: "Bash", input: "rm -rf x" },
      { type: "tool.end", id: "t1", error: "denied: Bash needs approval" },
      { type: "structured", data: { ok: true } },
      { type: "done", text: "the full answer", finishReason: "stop" },
    ];
    act(() => events.forEach((e) => a.push(e)));
    act(() => a.end());
    await waitFor(() => expect(result.current.status).toBe("done"));

    expect(result.current.result).toMatchObject({
      provider: "claude",
      model: "claude-1-20250101",
      text: "the full answer",
      structured: { ok: true },
      deniedActions: ["Bash"],
      finishReason: "stop",
      sessionId: "s1",
    });
    expect(result.current.text).toBe("the full answer");
  });
});

// --- useSelection ------------------------------------------------------------------------------------------------

describe("useSelection", () => {
  it("never pairs a locked provider with another provider's model", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useSelection(client, { locked: { provider: "claude" } }));
    await waitFor(() => expect(result.current.selection.model).toBe("claude-1"));

    act(() => result.current.set({ provider: "codex" }));
    await waitFor(() => expect(result.current.selection.model).toBe("claude-1"));
    expect(result.current.selection.provider).toBe("claude");
    expect(client.models).not.toHaveBeenCalledWith("codex", expect.anything());
  });

  it("checks locked fields against the provider's capabilities", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useSelection(client, { locked: { provider: "claude", cwd: "/work", access: "supervised" } }));
    await waitFor(() => expect(result.current.selection.model).toBe("claude-1"));
    expect(result.current.value).toBeUndefined();
    expect(result.current.problem).toMatch(/supervised/);
  });

  it("returns a value when every locked field fits", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useSelection(client, { locked: { provider: "claude", cwd: "/work", access: "full" } }));
    await waitFor(() => expect(result.current.value).toBeDefined());
    expect(result.current.problem).toBeUndefined();
  });

  it("shows a models() failure and retries it on refresh()", async () => {
    const client = fakeClient({
      models: vi.fn().mockRejectedValueOnce(new Error("ollama is down")).mockResolvedValue([model("claude-1")]),
    });
    const { result } = renderHook(() => useSelection(client, { locked: { provider: "claude" } }));
    await waitFor(() => expect(result.current.modelsError).toBe("ollama is down"));
    expect(result.current.models).toEqual([]);

    await act(() => result.current.refresh());
    await waitFor(() => expect(result.current.models).toHaveLength(1));
    expect(result.current.modelsError).toBeUndefined();
  });

  it("drops a providers() answer that arrives after a newer one", async () => {
    const first = deferred<ProviderOverview[]>();
    const second = deferred<ProviderOverview[]>();
    const client = fakeClient({ providers: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) });
    const { result } = renderHook(() => useSelection(client));

    act(() => void result.current.refresh());
    await act(async () => second.resolve([CODEX]));
    await act(async () => first.resolve([CLAUDE]));
    expect(result.current.providers.map((p) => p.id)).toEqual(["codex"]);
  });

  it("treats a provider without access levels as complete without access or folder", async () => {
    const client = fakeClient({ providers: vi.fn(async () => [OLLAMA]), models: vi.fn(async () => [model("llama3", "ollama")]) });
    const { result } = renderHook(() => useSelection(client));
    await waitFor(() => expect(result.current.value).toBeDefined());
    expect(result.current.selection.access).toBeUndefined();
    expect(result.current.value).toMatchObject({ provider: "ollama", model: "llama3", access: "none" });
  });
});

// --- useAuth -----------------------------------------------------------------------------------------------------

describe("useAuth", () => {
  it("clears the status when the provider changes", async () => {
    const next = deferred<{ loggedIn: boolean }>();
    const client = fakeClient({ authStatus: vi.fn().mockResolvedValueOnce({ loggedIn: true }).mockReturnValueOnce(next.promise) });
    const { result, rerender } = renderHook(({ provider }: { provider: ProviderId }) => useAuth(client, provider), { initialProps: { provider: "claude" as ProviderId } });
    await waitFor(() => expect(result.current.status?.loggedIn).toBe(true));

    rerender({ provider: "codex" });
    expect(result.current.status).toBeUndefined();
    await act(async () => next.resolve({ loggedIn: false }));
    expect(result.current.status?.loggedIn).toBe(false);
  });

  it("cancels a login in flight on unmount", async () => {
    const login = stream<LoginStreamEvent>();
    let signal!: AbortSignal;
    const client = fakeClient({ login: vi.fn((_id: ProviderId, s: AbortSignal) => ((signal = s), login.gen)) });
    const { result, unmount } = renderHook(() => useAuth(client, "claude"));

    act(() => void result.current.login());
    act(() => login.push({ type: "login", loginId: "L1" }));
    await waitFor(() => expect(client.login).toHaveBeenCalled());
    await act(async () => {});

    unmount();
    expect(client.cancelLogin).toHaveBeenCalledWith("L1");
    expect(signal.aborted).toBe(true);
  });
});

// --- components --------------------------------------------------------------------------------------------------

describe("FunnelPicker", () => {
  it("submits a selection for a provider without access levels", async () => {
    const client = fakeClient({ providers: vi.fn(async () => [OLLAMA]), models: vi.fn(async () => [model("llama3", "ollama")]) });
    const onChange = vi.fn();
    render(<FunnelPicker client={client} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "ollama", model: "llama3", access: "none" })));
    expect(screen.queryByText("Project folder")).toBeNull();
    expect(screen.queryByText("Machine access")).toBeNull();
  });

  it("shows a models() error with a retry button", async () => {
    const client = fakeClient({ models: vi.fn().mockRejectedValueOnce(new Error("no models")).mockResolvedValue([model("claude-1")]) });
    render(<FunnelPicker client={client} locked={{ provider: "claude" }} />);
    await screen.findByText("no models");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("no models")).toBeNull());
  });

  it("keeps the newest folder listing when answers arrive out of order, and uses no listbox role", async () => {
    const root: DirListing = { path: "/a", name: "a", parent: null, dirs: ["x", "y"] };
    const slow = deferred<DirListing>();
    const fast = deferred<DirListing>();
    const listDirs = vi.fn().mockResolvedValueOnce(root).mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const client = fakeClient({ listDirs });
    render(<FunnelPicker client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Browse" }));
    await screen.findByText("/a");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("group", { name: "Folders" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "x" }));
    fireEvent.click(screen.getByRole("button", { name: "y" }));
    await act(async () => fast.resolve({ path: "/a/y", name: "y", parent: "/a", dirs: [] }));
    await act(async () => slow.resolve({ path: "/a/x", name: "x", parent: "/a", dirs: [] }));
    expect(screen.getByText("/a/y")).toBeTruthy();
    expect(screen.queryByText("/a/x")).toBeNull();
  });
});

describe("ApprovalPrompt", () => {
  it("moves focus to the first button and gives it back on close", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(<ApprovalPrompt request={{ id: "1", tool: "Bash", input: "ls" }} onDecide={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Allow" }));
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
