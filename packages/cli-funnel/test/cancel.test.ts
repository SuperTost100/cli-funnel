import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClient, type RunEvent } from "../src/client/index.js";
import { createFunnel } from "../src/funnel.js";
import { createHandler } from "../src/server/handler.js";
import type { FunnelEvent, Provider } from "../src/types.js";

const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));

// Runs until its signal aborts, like a CLI that is still thinking.
const slow: Provider = {
  id: "claude",
  displayName: "Slow",
  capabilities: { access: ["supervised", "accept-edits", "full"], effort: false, contextWindow: false, fast: false, resume: false, approvals: true, images: false, system: "prompt", schema: "prompt" },
  detect: async () => ({ installed: true, testedRange: { min: "1.0.0" } }),
  authStatus: async () => ({ loggedIn: true }),
  login: () => {
    throw new Error("no");
  },
  logout: async () => {},
  update: async () => ({ changed: false, output: "" }),
  models: async () => [{ id: "slow-1", name: "Slow 1", provider: "claude", efforts: [], contextWindows: [], fast: false, source: "manifest" }],
  async *run(input): AsyncGenerator<FunnelEvent> {
    yield { type: "session", sessionId: "s1" };
    if (input.selection.access === "supervised") {
      const request = { id: "a1", tool: "Bash", input: { cmd: "ls" } };
      yield { type: "approval.request", request };
      yield { type: "text.delta", text: await input.onApproval!(request) };
    }
    await untilAborted(input.signal!);
    yield { type: "done", text: "", finishReason: "cancelled" };
  },
};

const cwd = mkdtempSync(join(tmpdir(), "cf-cancel-"));
const handler = createHandler(createFunnel({ providers: { claude: slow } }), { fsRoots: [tmpdir()], openai: { cwd } });
const client = createClient({ baseUrl: "http://x", fetch: (url, init) => handler(new Request(url as string, init)) });

describe("cancel a run by id", () => {
  it("stops a run started on /run", async () => {
    const seen: RunEvent[] = [];
    let runId = "";
    for await (const e of client.run({ selection: { provider: "claude", model: "slow-1", cwd, access: "full" }, prompt: "go" })) {
      seen.push(e);
      if (e.type === "run") runId = e.runId;
      if (e.type === "session") expect(await client.cancelRun(runId)).toEqual({ ok: true });
    }
    expect(seen.at(-1)).toEqual({ type: "done", text: "", finishReason: "cancelled" });
    await expect(client.cancelRun(runId)).rejects.toThrow("Unknown run");
  });

  it("denies the run's pending approvals", async () => {
    const seen: RunEvent[] = [];
    let runId = "";
    for await (const e of client.run({ selection: { provider: "claude", model: "slow-1", cwd, access: "supervised" }, prompt: "go" })) {
      seen.push(e);
      if (e.type === "run") runId = e.runId;
      if (e.type === "approval.request") await client.cancelRun(runId);
    }
    expect(seen).toContainEqual({ type: "text.delta", text: "deny" });
    expect(seen.at(-1)).toMatchObject({ type: "done", finishReason: "cancelled" });
  });

  it("answers 404 for a run it does not know", async () => {
    const res = await handler(new Request("http://x/runs/run_nope/cancel", { method: "POST" }));
    expect(res.status).toBe(404);
  });

  it("reports runId on streaming chat completions so they can be cancelled", async () => {
    const res = await handler(
      new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "claude/slow-1", stream: true, messages: [{ role: "user", content: "hi" }] }) }),
    );
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let body = "";
    let runId = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      body += value;
      if (!runId) {
        runId = body.match(/"runId":"([^"]+)"/)?.[1] ?? "";
        if (runId) expect((await handler(new Request(`http://x/runs/${runId}/cancel`, { method: "POST" }))).status).toBe(200);
      }
    }
    expect(runId).toMatch(/^run_/);
    expect(body.trim().endsWith("[DONE]")).toBe(true);
    expect((await handler(new Request(`http://x/runs/${runId}/cancel`, { method: "POST" }))).status).toBe(404);
  });
});
