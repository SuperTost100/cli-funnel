import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRetrying, httpError } from "../src/providers/http.js";
import type { FunnelEvent } from "../src/types.js";

afterEach(() => vi.unstubAllGlobals());

async function drive<T>(gen: AsyncGenerator<FunnelEvent, T>): Promise<{ events: FunnelEvent[]; value: T }> {
  const events: FunnelEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, value: step.value };
    events.push(step.value);
  }
}

describe("fetchRetrying", () => {
  it("waits for retry-after-ms, as the reported limit does", async () => {
    const answers = [new Response("busy", { status: 429, headers: { "retry-after-ms": "7" } }), new Response("ok")];
    vi.stubGlobal("fetch", vi.fn(async () => answers.shift()!));
    const { events, value } = await drive(fetchRetrying("http://x", {}, { retryDelayMs: 10_000 }));
    expect(events).toEqual([{ type: "retry", attempt: 1, status: 429, delayMs: 7 }]);
    expect(value.ok).toBe(true);
  });

  it("lets retry-after-ms win over retry-after", async () => {
    const headers = { "retry-after-ms": "5", "retry-after": "20" };
    const answers = [new Response("busy", { status: 429, headers }), new Response("ok")];
    vi.stubGlobal("fetch", vi.fn(async () => answers.shift()!));
    const { events } = await drive(fetchRetrying("http://x", {}));
    expect(events).toMatchObject([{ type: "retry", delayMs: 5 }]);
  });
});

describe("httpError", () => {
  it("puts a limit before the error and caps a huge body", async () => {
    const body = "x".repeat(1_000_000);
    const { events } = await drive(httpError("Test API", new Response(body, { status: 429, headers: { "retry-after": "2" } })));
    expect(events[0]).toMatchObject({ type: "limit", kind: "rate", retryAfterMs: 2000 });
    const error = events[1] as Extract<FunnelEvent, { type: "error" }>;
    expect(error.message.startsWith("Test API 429: xxx")).toBe(true);
    expect(error.message.length).toBeLessThan(2100);
  });

  it("keeps a short body whole", async () => {
    const { events } = await drive(httpError("Test API", new Response("nope", { status: 400 })));
    expect(events).toEqual([{ type: "error", message: "Test API 400: nope", code: "cli-failed" }]);
  });
});

describe("redirects", () => {
  it("sends provider requests without following redirects", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await drive(fetchRetrying("http://x", { method: "POST" }));
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("turns a 3xx answer into an error that names the status and not the Location", async () => {
    const res = new Response("", { status: 307, headers: { location: "http://127.0.0.1:4747/codex/logout?x=secret" } });
    const { events } = await drive(httpError("Test API", res));
    expect(events).toHaveLength(1);
    const error = events[0] as Extract<FunnelEvent, { type: "error" }>;
    expect(error.message).toContain("307");
    expect(error.message).toContain("redirect");
    expect(error.message).not.toContain("4747");
    expect(error.message).not.toContain("secret");
  });
});
