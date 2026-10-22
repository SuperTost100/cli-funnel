import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { DEFAULT_MAX_QUEUED_RUNS, RunQueue } from "../src/queue.js";
import { createHandler } from "../src/server/handler.js";
import type { FunnelEvent, Provider, ProviderId, RunInput } from "../src/types.js";

const cwd = mkdtempSync(join(tmpdir(), "cf-queue-"));
const tick = () => new Promise((r) => setTimeout(r, 5));

// Each run waits until the test calls `finish()` or its signal aborts.
const finishers: (() => void)[] = [];
const finishAll = () => finishers.splice(0).forEach((f) => f());
const gated = (id: ProviderId): Provider => ({
  id,
  displayName: id,
  capabilities: { access: ["accept-edits", "full"], effort: false, contextWindow: false, fast: false, resume: false, approvals: false, images: false, system: "prompt", schema: "prompt" },
  detect: async () => ({ installed: true, testedRange: { min: "1.0.0" } }),
  authStatus: async () => ({ loggedIn: true }),
  login: () => {
    throw new Error("no");
  },
  logout: async () => {},
  update: async () => ({ changed: false, output: "" }),
  models: async () => [{ id: "m", name: "m", provider: id, efforts: [], contextWindows: [], fast: false, source: "manifest" }],
  async *run(input): AsyncGenerator<FunnelEvent> {
    yield { type: "session", sessionId: `s-${id}` };
    const aborted = await new Promise<boolean>((resolve) => {
      finishers.push(() => resolve(false));
      input.signal?.addEventListener("abort", () => resolve(true), { once: true });
    });
    yield aborted ? { type: "done", text: "", finishReason: "cancelled" } : { type: "done", text: "ok", finishReason: "stop" };
  },
});
const providers = { claude: gated("claude"), codex: gated("codex") };
const input = (provider: ProviderId = "claude", extra: Partial<RunInput> = {}): RunInput => ({ selection: { provider, model: "m", cwd, access: "full" }, prompt: "go", ...extra });

/** Reads a stream in the background and keeps every event. */
function drain(stream: AsyncIterable<FunnelEvent>) {
  const events: FunnelEvent[] = [];
  const done = (async () => {
    for await (const e of stream) events.push(e);
  })();
  return { events, done };
}

describe("RunQueue", () => {
  it("starts runs in order and reports how many wait ahead", async () => {
    const q = new RunQueue({ maxConcurrentRuns: 1 });
    const positions: Record<string, number[]> = { b: [], c: [] };
    const releaseA = await q.acquire("claude");
    const b = q.acquire("claude", { onPosition: (n) => positions.b!.push(n) });
    const c = q.acquire("claude", { onPosition: (n) => positions.c!.push(n) });
    expect(positions).toEqual({ b: [0], c: [1] });
    releaseA();
    const releaseB = await b;
    expect(positions.c).toEqual([1, 0]);
    releaseB();
    (await c)();
  });

  it("caps each provider on its own", async () => {
    const q = new RunQueue({ maxConcurrentRuns: { total: 3, perProvider: { claude: 1 } } });
    await q.acquire("claude");
    let started = false;
    void q.acquire("claude").then(() => (started = true));
    await q.acquire("codex");
    await tick();
    expect(started).toBe(false);
  });

  it("refuses runs when the queue is full or the wait is too long", async () => {
    const full = new RunQueue({ maxConcurrentRuns: 1, maxQueuedRuns: 1 });
    await full.acquire("claude");
    void full.acquire("claude");
    expect(full.full("claude")).toBe(true);
    await expect(full.acquire("claude")).rejects.toMatchObject({ code: "busy" });

    const slow = new RunQueue({ maxConcurrentRuns: 1, queueTimeoutMs: 10 });
    await slow.acquire("claude");
    await expect(slow.acquire("claude")).rejects.toMatchObject({ code: "busy" });
  });

  it("lets at most 100 runs wait when maxQueuedRuns is not set", async () => {
    const q = new RunQueue({ maxConcurrentRuns: 1 });
    await q.acquire("claude");
    for (let i = 0; i < DEFAULT_MAX_QUEUED_RUNS; i++) void q.acquire("claude");
    expect(DEFAULT_MAX_QUEUED_RUNS).toBe(100);
    expect(q.full("claude")).toBe(true);
    await expect(q.acquire("claude")).rejects.toMatchObject({ code: "busy" });
  });

  it("drops a waiting run when its signal aborts", async () => {
    const q = new RunQueue({ maxConcurrentRuns: 1 });
    const release = await q.acquire("claude");
    const controller = new AbortController();
    const first = q.acquire("claude", { signal: controller.signal });
    const positions: number[] = [];
    const second = q.acquire("claude", { onPosition: (n) => positions.push(n) });
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "aborted" });
    expect(positions).toEqual([1, 0]);
    release();
    (await second)();
  });
});

describe("createFunnel with maxConcurrentRuns", () => {
  it("queues the second run and streams its position", async () => {
    const funnel = createFunnel({ providers, maxConcurrentRuns: 1 });
    const a = drain(funnel.stream(input()));
    await tick();
    const b = drain(funnel.stream(input()));
    await tick();
    expect(b.events).toEqual([{ type: "queue.position", ahead: 0 }]);
    finishAll();
    await a.done;
    await tick();
    finishAll();
    await b.done;
    expect(b.events.map((e) => e.type)).toEqual(["queue.position", "session", "done"]);
  });

  it("ends a run cancelled while it waits as cancelled", async () => {
    const funnel = createFunnel({ providers, maxConcurrentRuns: 1 });
    const a = drain(funnel.stream(input()));
    await tick();
    const controller = new AbortController();
    const b = funnel.stream(input("claude", { signal: controller.signal }));
    const events = drain(b);
    await tick();
    controller.abort();
    await events.done;
    expect(events.events.at(-1)).toEqual({ type: "done", text: "", finishReason: "cancelled" });
    expect((await b.result).finishReason).toBe("cancelled");
    finishAll();
    await a.done;
  });
});

describe("handler with maxConcurrentRuns", () => {
  const funnel = createFunnel({ providers });
  const post = (h: ReturnType<typeof createHandler>, path: string, body: unknown) => h(new Request("http://x" + path, { method: "POST", body: JSON.stringify(body) }));
  const runBody = { selection: { provider: "claude", model: "m", cwd, access: "full" }, prompt: "go" };
  const chatBody = { model: "claude/m", messages: [{ role: "user", content: "hi" }] };

  it("answers 429 with retry-after when the queue is full", async () => {
    const h = createHandler(funnel, { fsRoots: [tmpdir()], openai: { cwd }, maxConcurrentRuns: 1, maxQueuedRuns: 0 });
    const first = await post(h, "/run", runBody);
    const reader = first.body!.getReader();
    await reader.read();
    await tick();
    const run = await post(h, "/run", runBody);
    expect(run.status).toBe(429);
    expect(run.headers.get("retry-after")).toBe("5");
    const chat = await post(h, "/v1/chat/completions", chatBody);
    expect(chat.status).toBe(429);
    expect((await chat.json()).error.code).toBe("busy");
    // The provider registers its finisher once the stream is read far enough.
    for (;;) {
      finishAll();
      if ((await reader.read()).done) break;
    }
  });

  it("streams queue.position on /run and lets a queued run be cancelled by id", async () => {
    const h = createHandler(funnel, { fsRoots: [tmpdir()], openai: { cwd }, maxConcurrentRuns: 1 });
    const first = (await post(h, "/run", runBody)).text();
    await tick();
    const second = await post(h, "/run", runBody);
    const reader = second.body!.pipeThrough(new TextDecoderStream()).getReader();
    let seen = "";
    while (!seen.includes("queue.position")) seen += (await reader.read()).value;
    const runId = seen.match(/"runId":"([^"]+)"/)![1];
    expect((await post(h, `/runs/${runId}/cancel`, {})).status).toBe(200);
    for (let r = await reader.read(); !r.done; r = await reader.read()) seen += r.value;
    expect(seen).toContain('"ahead":0');
    expect(seen).toContain('"finishReason":"cancelled"');
    finishAll();
    expect(await first).toContain('"finishReason":"stop"');
  });

  it("reports x_funnel.queued on chat completions that waited", async () => {
    const h = createHandler(funnel, { fsRoots: [tmpdir()], openai: { cwd }, maxConcurrentRuns: 1 });
    const first = post(h, "/v1/chat/completions", chatBody);
    await tick();
    const second = post(h, "/v1/chat/completions", chatBody);
    await tick();
    finishAll();
    expect((await (await first).json()).x_funnel.queued).toBeUndefined();
    await tick();
    finishAll();
    const queued = (await (await second).json()).x_funnel.queued;
    expect(queued.waitedMs).toBeGreaterThanOrEqual(0);
  });
});
