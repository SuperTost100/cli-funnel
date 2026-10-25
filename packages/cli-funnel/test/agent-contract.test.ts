import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client/index.js";
import { createFunnel } from "../src/funnel.js";
import { approvalReply, askQuestion, createRunFolder } from "../src/providers/base.js";
import { mcpServersFor } from "../src/providers/options.js";
import { toReply } from "../src/providers/codex/approvals.js";
import { createHandler } from "../src/server/handler.js";
import type { FunnelEvent, Provider, QuestionRequest, RunInput } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "cf-contract-"));

const base: Provider = {
  id: "claude",
  displayName: "Fake",
  capabilities: { access: ["none", "supervised", "full"], effort: false, contextWindow: false, fast: false, resume: true, approvals: true, images: false, system: "prompt", schema: "prompt" },
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

const input = (access: RunInput["selection"]["access"], mcpServers: unknown): RunInput =>
  ({ selection: { provider: "claude", model: "m", cwd: root, access }, prompt: "go", mcpServers }) as RunInput;

describe("mcpServersFor", () => {
  const http = { app: { type: "http", url: "http://127.0.0.1:9000/mcp", headers: { Authorization: "Bearer x" }, toolTimeoutSec: 600 } };
  const stdio = { local: { type: "stdio", command: "node", args: ["server.js"] } };

  it("takes an HTTP server at supervised and refuses it at none", () => {
    expect(mcpServersFor(input("supervised", http), ["http", "stdio"])).toEqual([["app", http.app]]);
    expect(() => mcpServersFor(input("none", http), ["http"])).toThrow(/not allowed at access "none"/);
  });

  it("refuses a stdio server below full", () => {
    expect(() => mcpServersFor(input("supervised", stdio), ["http", "stdio"])).toThrow(/stdio MCP server is not allowed at access "supervised"/);
    expect(mcpServersFor(input("full", stdio), ["http", "stdio"])).toHaveLength(1);
  });

  it("refuses a type the provider cannot attach, bad names, bad URLs and unknown keys", () => {
    expect(() => mcpServersFor(input("full", stdio), ["http"])).toThrow(expect.objectContaining({ code: "unsupported" }));
    expect(() => mcpServersFor(input("full", { "a b": http.app }), ["http"])).toThrow(/name/);
    expect(() => mcpServersFor(input("full", { a: { type: "http", url: "file:///etc/passwd" } }), ["http"])).toThrow(/http or https/);
    expect(() => mcpServersFor(input("full", { a: { ...http.app, command: "sh" } }), ["http"])).toThrow(/Unknown key command/);
    expect(() => mcpServersFor(input("full", { a: { type: "http", url: "http://x", headers: { n: 1 } } }), ["http"])).toThrow(/headers/);
  });

  it("returns nothing when there are no servers", () => {
    expect(mcpServersFor(input("none", undefined), [])).toEqual([]);
    expect(mcpServersFor(input("none", {}), [])).toEqual([]);
  });
});

describe("approvalReply", () => {
  it("turns strings and objects into the object form, and anything else into deny", () => {
    expect(approvalReply("allow")).toEqual({ decision: "allow" });
    expect(approvalReply("deny")).toEqual({ decision: "deny" });
    expect(approvalReply("yes")).toEqual({ decision: "deny" });
    expect(approvalReply({ decision: "deny", message: "Ask first" })).toEqual({ decision: "deny", message: "Ask first" });
    expect(approvalReply({ decision: "allow", updatedInput: { a: 1 } })).toEqual({ decision: "allow", updatedInput: { a: 1 } });
    // A deny never carries new input.
    expect(approvalReply({ decision: "deny", updatedInput: { a: 1 } })).toEqual({ decision: "deny" });
  });
});

describe("a provider that cannot change the input", () => {
  it("declines an allow that carries updatedInput instead of running the original", () => {
    const req = { id: 1, method: "item/commandExecution/requestApproval", params: {} };
    expect(toReply(req, { decision: "allow", updatedInput: { command: "ls" } })).toEqual({ result: { decision: "decline" } });
    expect(toReply(req, { decision: "allow" })).toEqual({ result: { decision: "accept" } });
  });
});

describe("askQuestion", () => {
  const request: QuestionRequest = { id: "q", questions: [{ id: "color", question: "Which?", options: [{ label: "Red" }] }] };
  const ask = (onQuestion: RunInput["onQuestion"]) => askQuestion({ ...input("supervised", undefined), onQuestion }, request);

  it("keeps answers to asked questions and drops the rest", async () => {
    expect(await ask(() => ({ color: ["Red"], other: ["x"] }))).toEqual({ color: ["Red"] });
  });

  it("means no answer without a handler, on a throw, or on a malformed answer", async () => {
    expect(await ask(undefined)).toBeNull();
    expect(await ask(() => Promise.reject(new Error("x")))).toBeNull();
    expect(await ask(() => null)).toBeNull();
    expect(await ask(() => "Red" as never)).toBeNull();
  });
});

describe("run result", () => {
  it("keeps the last plan, every file change and the login kind", () => {
    const folder = createRunFolder(input("full", undefined));
    folder.add({ type: "session", sessionId: "s", auth: "api-key" });
    folder.add({ type: "plan", steps: [{ text: "a", status: "in_progress" }] });
    folder.add({ type: "plan", steps: [{ text: "a", status: "done" }] });
    folder.add({ type: "file.change", id: "t1", path: "/p/a.txt", kind: "add", status: "done" });
    folder.add({ type: "file.change", id: "t2", path: "/p/b.txt", kind: "delete", status: "declined" });
    const r = folder.finish();
    expect(r.auth).toBe("api-key");
    expect(r.plan).toEqual([{ text: "a", status: "done" }]);
    expect(r.fileChanges).toEqual([
      { id: "t1", path: "/p/a.txt", kind: "add", status: "done" },
      { id: "t2", path: "/p/b.txt", kind: "delete", status: "declined" },
    ]);
  });
});

describe("funnel checks", () => {
  const funnel = createFunnel({ providers: { claude: base } });
  const run = (extra: Partial<RunInput>) => funnel.run({ selection: { provider: "claude", model: "m", cwd: root, access: "full" }, prompt: "go", ...extra });

  it("refuses an API key or MCP servers the provider cannot take", async () => {
    await expect(run({ apiKey: "sk-test" })).rejects.toMatchObject({ code: "unsupported" });
    await expect(run({ mcpServers: { a: { type: "http", url: "http://x" } } })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("passes them to a provider that takes them", async () => {
    let seen: RunInput | undefined;
    const able: Provider = {
      ...base,
      capabilities: { ...base.capabilities, apiKey: true, mcpServers: ["http"] },
      async *run(i) {
        seen = i;
        yield { type: "done", text: "", finishReason: "stop" };
      },
    };
    const f = createFunnel({ providers: { claude: able } });
    await f.run({ selection: { provider: "claude", model: "m", cwd: root, access: "supervised" }, prompt: "go", onApproval: () => "deny", apiKey: "sk-test", mcpServers: { a: { type: "http", url: "http://x" } } });
    expect(seen?.apiKey).toBe("sk-test");
    expect(seen?.mcpServers).toEqual({ a: { type: "http", url: "http://x" } });
  });
});

describe("server answers", () => {
  /** Asks one approval and one question, and writes what came back as the answer text. */
  const asking: Provider = {
    ...base,
    capabilities: { ...base.capabilities, questions: true },
    async *run(i) {
      const approval = { id: "a1", tool: "Bash", input: {} };
      yield { type: "approval.request", request: approval };
      const decision = await i.onApproval!(approval);
      const request: QuestionRequest = { id: "q1", questions: [{ id: "pick", question: "Which?", options: [{ label: "A" }, { label: "B" }, { label: "C" }], allowOther: true }] };
      yield { type: "question.request", request };
      const answers = await i.onQuestion!(request);
      const text = JSON.stringify({ decision, answers });
      yield { type: "done", text, finishReason: "stop" };
    },
  };
  const handler = createHandler(createFunnel({ providers: { claude: asking } }), { fsRoots: [root], openai: { cwd: root } });
  const client = createClient({ baseUrl: "http://x", fetch: (url, init) => handler(new Request(url as string, init)) });

  async function roundTrip(decision: Parameters<typeof client.approve>[2], answers: Parameters<typeof client.answer>[2]) {
    let runId = "";
    let text = "";
    for await (const e of client.run({ selection: { provider: "claude", model: "m", cwd: root, access: "supervised" }, prompt: "go" })) {
      if (e.type === "run") runId = e.runId;
      if (e.type === "approval.request") await client.approve(runId, e.request.id, decision);
      if (e.type === "question.request") await client.answer(runId, e.request.id, answers);
      if (e.type === "done") text = e.text;
    }
    return JSON.parse(text);
  }

  it("passes a deny with a message and free-text answers through to the provider", async () => {
    expect(await roundTrip({ decision: "deny", message: "Ask through the app" }, { pick: ["Something else"] })).toEqual({
      decision: { decision: "deny", message: "Ask through the app" },
      answers: { pick: ["Something else"] },
    });
  });

  it("keeps a plain decision a string, and passes a declined question as null", async () => {
    expect(await roundTrip("allow", null)).toEqual({ decision: "allow", answers: null });
  });

  it("refuses malformed answers", async () => {
    const res = await handler(new Request("http://x/questions/run_x/q1", { method: "POST", body: JSON.stringify({ answers: { pick: "A" } }) }));
    expect(res.status).toBe(400);
  });
});

describe("run secrets", () => {
  it("masks the API key and credential headers in every event, and leaves other values alone", async () => {
    const leaky: Provider = {
      ...base,
      capabilities: { ...base.capabilities, apiKey: true, mcpServers: ["http"] },
      async *run() {
        yield { type: "tool.start", id: "t", name: "Bash", input: { command: "echo sk-test-key-123456" } };
        yield { type: "tool.end", id: "t", output: "CURSOR_API_KEY=sk-test-key-123456 X=Bearer-header-secret" };
        yield { type: "done", text: "Your key is sk-test-key-123456 and the type is application/json", finishReason: "stop" };
      },
    };
    const events: FunnelEvent[] = [];
    const f = createFunnel({ providers: { claude: leaky }, onEvent: (r) => void events.push(r.event) });
    const result = await f.run({
      selection: { provider: "claude", model: "m", cwd: root, access: "full" },
      prompt: "go",
      apiKey: "sk-test-key-123456",
      mcpServers: { a: { type: "http", url: "http://x", headers: { Authorization: "Bearer-header-secret", Accept: "application/json" } } },
    });
    expect(result.text).toBe("Your key is [redacted] and the type is application/json");
    expect(result.toolCalls[0]!.input).toEqual({ command: "echo [redacted]" });
    expect(JSON.stringify(events)).not.toMatch(/sk-test-key|Bearer-header-secret/);
  });

  it("masks a thrown error, a short key, keys of objects, and a longer secret whole", async () => {
    const throwing: Provider = {
      ...base,
      capabilities: { ...base.capabilities, apiKey: true, mcpServers: ["http"] },
      async *run() {
        yield { type: "tool.start", id: "t", name: "x", input: { "abc12": 1, token: "abc12-header-long" } };
        throw new Error("401 for key abc12");
      },
    };
    const records: FunnelEvent[] = [];
    const f = createFunnel({ providers: { claude: throwing }, onEvent: (r) => void records.push(r.event) });
    const req = {
      selection: { provider: "claude" as const, model: "m", cwd: root, access: "full" as const },
      prompt: "go",
      apiKey: "abc12",
      mcpServers: { a: { type: "http" as const, url: "http://x", headers: { "X-Token": "abc12-header-long" } } },
    };
    await expect(f.run(req)).rejects.toThrow("401 for key [redacted]");
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/abc12/);
    expect(text).toContain('{"[redacted]":1,"token":"[redacted]"}');
  });

  it("refuses the server name __proto__, which would vanish from a plain object", () => {
    const servers = JSON.parse('{"__proto__": {"type": "http", "url": "http://x"}}');
    expect(() => mcpServersFor(input("full", servers), ["http"])).toThrow(/reserved/);
  });
});
