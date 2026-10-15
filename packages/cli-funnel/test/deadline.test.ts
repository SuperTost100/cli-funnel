import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createHandler } from "../src/server/handler.js";
import type { FunnelEvent, Provider, RunInput } from "../src/types.js";

const cwd = mkdtempSync(join(tmpdir(), "cf-deadline-"));
const seen: { signal?: AbortSignal; closed: boolean } = { closed: false };

// "hang" never ends and ignores its signal, like a stalled vendor stream. "quick" answers at once.
const fake: Provider = {
  id: "claude",
  displayName: "Fake",
  binary: "fake",
  capabilities: { access: ["accept-edits", "full"], effort: false, contextWindow: false, fast: false, resume: false, approvals: false, images: false, system: "prompt", schema: "prompt" },
  detect: async () => ({ installed: true, testedRange: { min: "1.0.0" } }),
  authStatus: async () => ({ loggedIn: true }),
  login: () => {
    throw new Error("no");
  },
  logout: async () => {},
  update: async () => ({ changed: false, output: "" }),
  models: async () => ["hang", "quick"].map((id) => ({ id, name: id, provider: "claude" as const, efforts: [], contextWindows: [], fast: false, source: "manifest" as const })),
  async *run(input): AsyncGenerator<FunnelEvent> {
    seen.signal = input.signal;
    seen.closed = false;
    try {
      yield { type: "text.delta", text: "partial" };
      if (input.selection.model === "hang") await new Promise(() => {});
      yield { type: "done", text: "", finishReason: "stop" };
    } finally {
      seen.closed = true;
    }
  },
};

const funnel = createFunnel({ providers: { claude: fake } });
const input = (model: string, extra: Partial<RunInput> = {}): RunInput => ({ selection: { provider: "claude", model, cwd, access: "full" }, prompt: "go", ...extra });

describe("run deadline", () => {
  it("ends a hung run at timeoutMs with finishReason cancelled and timeout", async () => {
    const started = Date.now();
    const result = await funnel.run(input("hang", { timeoutMs: 50 }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({ text: "partial", finishReason: "cancelled", timeout: true });
    expect(seen.signal?.aborted).toBe(true);
  });

  it("streams the timeout on the done event", async () => {
    const events: FunnelEvent[] = [];
    for await (const e of funnel.stream(input("hang", { timeoutMs: 20 }))) events.push(e);
    expect(events.at(-1)).toEqual({ type: "done", text: "", finishReason: "cancelled", timeout: true });
  });

  it("leaves a run that finishes in time alone", async () => {
    const result = await funnel.run(input("quick", { timeoutMs: 5000 }));
    expect(result.finishReason).toBe("stop");
    expect(result.timeout).toBeUndefined();
    expect(seen.signal?.aborted).toBe(false);
  });

  it("still passes the caller's abort through", async () => {
    const controller = new AbortController();
    const stream = funnel.stream(input("quick", { timeoutMs: 5000, signal: controller.signal }));
    for await (const _ of stream) controller.abort();
    expect(seen.signal?.aborted).toBe(true);
  });

  it("closes the provider when the consumer stops early", async () => {
    for await (const _ of funnel.stream(input("quick", { timeoutMs: 5000 }))) break;
    expect(seen.closed).toBe(true);
  });

  it("applies the handler's maxRunMs to /run and /v1/chat/completions", async () => {
    const handler = createHandler(funnel, { fsRoots: [tmpdir()], openai: { cwd }, maxRunMs: 30 });
    const post = (path: string, body: unknown) => handler(new Request("http://x" + path, { method: "POST", body: JSON.stringify(body) }));
    const run = await (await post("/run", { selection: { provider: "claude", model: "hang", cwd, access: "full" }, prompt: "go" })).text();
    expect(run).toContain('"finishReason":"cancelled","timeout":true');
    const chat = await (await post("/v1/chat/completions", { model: "claude/hang", messages: [{ role: "user", content: "hi" }] })).json();
    expect(chat.choices[0].message.content).toBe("partial");
  });
});
