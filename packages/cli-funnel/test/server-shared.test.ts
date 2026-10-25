import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createHandler } from "../src/server/handler.js";
import { sse } from "../src/server/sse.js";
import { FunnelError, type FunnelEvent, type PullEvent, type Provider } from "../src/types.js";

const base: Provider = {
  id: "claude",
  displayName: "Fake",
  capabilities: { access: ["none", "supervised", "accept-edits", "full"], effort: false, contextWindow: false, fast: false, resume: true, approvals: true, images: false, system: "prompt", schema: "prompt" },
  detect: async () => ({ installed: true, testedRange: { min: "1.0.0" }, version: "1.0.0", withinTestedRange: true }),
  authStatus: async () => ({ loggedIn: true }),
  login: () => {
    throw new Error("no");
  },
  logout: async () => {},
  update: async () => ({ changed: false, output: "" }),
  models: async () => [{ id: "m", name: "M", provider: "claude", efforts: [], contextWindows: [], fast: false, source: "manifest" }],
  async *run(): AsyncGenerator<FunnelEvent> {
    yield { type: "done", text: "", finishReason: "stop" };
  },
};

const root = mkdtempSync(join(tmpdir(), "cf-shared-"));

function setup(provider: Provider, options: Parameters<typeof createHandler>[1] = {}) {
  const handler = createHandler(createFunnel({ providers: { [provider.id]: provider } }), { fsRoots: [root], openai: { cwd: root }, ...options });
  return (path: string, body: unknown) => handler(new Request("http://x" + path, { method: "POST", body: JSON.stringify(body) }));
}

/** Provider whose run asks for approval "a1" once `gate` opens, and answers with the decision. */
function approving(gate: Promise<void>): Provider {
  return {
    ...base,
    async *run(input) {
      await gate;
      const answer = await input.onApproval!({ id: "a1", tool: "Bash", input: {} });
      const d = typeof answer === "string" ? answer : answer.decision;
      yield { type: "text.delta", text: d };
      yield { type: "done", text: d, finishReason: "stop" };
    },
  };
}

const supervised = { selection: { provider: "claude", model: "m", cwd: root, access: "supervised" }, prompt: "go" };

afterEach(() => vi.useRealTimers());

describe("early approval decisions", () => {
  it("keeps an answer for a live run that has not asked yet", async () => {
    let open!: () => void;
    const post = setup(approving(new Promise<void>((r) => (open = r))));
    const res = await post("/run", supervised);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = "";
    while (!seen.includes('"runId"')) seen += dec.decode((await reader.read()).value);
    const runId = seen.match(/"runId":"([^"]+)"/)![1]!;
    expect((await post(`/approvals/${runId}/a1`, { decision: "allow" })).status).toBe(200);
    open();
    while (!seen.includes('"type":"done"')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
    expect(seen).toContain('"text":"allow"');
  });

  it("drops an answer for a run id that does not exist, even if a run takes that id later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    // The first run of a new handler gets this id.
    const nextId = `run_1_${Date.now().toString(36)}`;
    const post = setup(approving(Promise.resolve()), { approvalTimeoutSec: 0.05 });
    expect(await (await post(`/approvals/${nextId}/a1`, { decision: "allow" })).json()).toEqual({ ok: true });
    const text = await (await post("/run", supervised)).text();
    expect(text).toContain(nextId);
    // The planted "allow" was not stored, so the approval waited and the timeout denied it.
    expect(text).toContain('"text":"deny"');
  });
});

describe("sse error events", () => {
  const read = async (stream: ReadableStream<Uint8Array>) => new TextDecoder().decode((await stream.getReader().read()).value);

  it("sends the message without the Error prefix, and the code", async () => {
    const items = (async function* () {
      throw new FunnelError("boom", "cli-failed");
    })();
    expect(await read(sse(items))).toBe('data: {"type":"error","message":"boom","code":"cli-failed"}\n\n');
  });

  it("stringifies a thrown value that is not an Error", async () => {
    const items = (async function* () {
      throw "plain";
    })();
    expect(await read(sse(items))).toBe('data: {"type":"error","message":"plain"}\n\n');
  });

  it("gives a failing model pull the same shape on the wire", async () => {
    const provider: Provider = {
      ...base,
      capabilities: { ...base.capabilities, manageModels: true },
      async *pullModel(): AsyncGenerator<PullEvent> {
        throw new FunnelError("no space left", "cli-failed");
      },
    };
    const res = await setup(provider)("/providers/claude/models/pull", { name: "m" });
    expect(await res.text()).toBe('data: {"type":"error","message":"no space left","code":"cli-failed"}\n\n');
  });
});

describe("tool_choice on a provider that runs its own tools", () => {
  const cli: Provider = { ...base, capabilities: { ...base.capabilities, tools: false } };
  const ask = (path: string, body: object) => setup(cli)(path, { model: "claude/m", ...body });

  it("lets auto and none through on /v1/responses as it does on chat completions", async () => {
    for (const tool_choice of ["auto", "none"]) {
      expect((await ask("/v1/responses", { input: "hi", tool_choice })).status).toBe(200);
      expect((await ask("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }], tool_choice })).status).toBe(200);
    }
  });

  it("still refuses a forced tool call", async () => {
    expect((await ask("/v1/responses", { input: "hi", tool_choice: "required" })).status).toBe(400);
  });
});
