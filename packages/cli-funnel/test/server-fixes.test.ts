import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createHandler } from "../src/server/handler.js";
import type { ApprovalDecision, FunnelEvent, Provider, ProviderId, RunInput } from "../src/types.js";

const MODEL = { id: "m1", name: "M1", efforts: [], contextWindows: [], fast: false, source: "manifest" as const };

/** A provider that plays back the events `script` returns for each run. */
function scripted(
  id: ProviderId,
  script: (input: RunInput) => AsyncIterable<FunnelEvent> | FunnelEvent[],
  patch: Partial<Provider> = {},
): Provider {
  return {
    id,
    displayName: id,
    binary: id,
    capabilities: { access: ["none", "supervised", "accept-edits", "full"], effort: false, contextWindow: false, fast: false, resume: true, approvals: true, images: false, system: "prompt", schema: "prompt" },
    detect: async () => ({ installed: true, testedRange: { min: "1.0.0" }, version: "1.0.0", withinTestedRange: true }),
    authStatus: async () => ({ loggedIn: true }),
    login: () => {
      throw new Error("no");
    },
    logout: async () => {},
    update: async () => ({ changed: false, output: "" }),
    models: async () => [{ ...MODEL, provider: id }],
    async *run(input) {
      yield* script(input);
    },
    ...patch,
  };
}

const done = (text = "", finishReason: "stop" | "length" = "stop"): FunnelEvent => ({ type: "done", text, finishReason });
const delta = (text: string): FunnelEvent => ({ type: "text.delta", text });

/** A funnel where every provider not given is stubbed as not installed, so listing models never starts a real CLI. */
function quietFunnel(providers: Partial<Record<ProviderId, Provider>>) {
  const ids: ProviderId[] = ["claude", "codex", "agent", "antigravity", "anthropic-api", "openai-api", "gemini-api", "ollama"];
  const absent = (id: ProviderId) => scripted(id, () => [], { detect: async () => ({ installed: false, testedRange: { min: "1.0.0" } }) });
  return createFunnel({ providers: { ...Object.fromEntries(ids.map((id) => [id, absent(id)])), ...providers } });
}

const root = mkdtempSync(join(tmpdir(), "cf-fix-"));
const chatBody = (extra: object = {}, model = "claude/m1") => ({ model, messages: [{ role: "user", content: "hi" }], ...extra });

function setup(provider: Provider, options: Parameters<typeof createHandler>[1] = {}) {
  const funnel = createFunnel({ providers: { [provider.id]: provider } });
  const handler = createHandler(funnel, { fsRoots: [root], openai: { cwd: root }, ...options });
  const post = (path: string, body: unknown, init: RequestInit = {}) =>
    handler(new Request("http://x" + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init }));
  const get = (path: string) => handler(new Request("http://x" + path));
  const chat = (extra?: object, model?: string) => post("/v1/chat/completions", chatBody(extra, model));
  return { handler, post, get, chat };
}

/** Parses an SSE body into its JSON events and whether it ended with [DONE]. */
async function readSse(res: Response) {
  const raw = await res.text();
  const lines = raw.split("\n\n").map((l) => l.replace(/^data: /, "")).filter(Boolean);
  return { done: lines.at(-1) === "[DONE]", chunks: lines.filter((l) => l !== "[DONE]").map((l) => JSON.parse(l)) };
}

const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms))]);

describe("approvals of an aborted run (#59)", () => {
  function supervised() {
    let settle!: (d: ApprovalDecision) => void;
    const decision = new Promise<ApprovalDecision>((r) => (settle = r));
    const provider = scripted("claude", async function* (input) {
      const request = { id: "a1", tool: "Bash", input: {} };
      yield { type: "approval.request", request };
      settle(await input.onApproval!(request));
      yield done();
    });
    return { provider, decision };
  }
  const startRun = (post: ReturnType<typeof setup>["post"], signal: AbortSignal) =>
    post("/run", { selection: { provider: "claude", model: "m1", cwd: root, access: "supervised" }, prompt: "go" }, { signal });

  async function readUntil(res: Response, needle: string) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = "";
    while (!seen.includes(needle)) {
      const { value, done: end } = await reader.read();
      if (end) break;
      seen += dec.decode(value);
    }
    return reader;
  }

  it("denies the pending approval when the request aborts", async () => {
    const { provider, decision } = supervised();
    const { post } = setup(provider);
    const ac = new AbortController();
    const res = await startRun(post, ac.signal);
    await readUntil(res, "approval.request");
    ac.abort();
    expect(await timeout(decision, 1000, "the approval to settle")).toBe("deny");
  });

  it("denies the pending approval when the response body is cancelled", async () => {
    const { provider, decision } = supervised();
    const { post } = setup(provider);
    const res = await startRun(post, new AbortController().signal);
    const reader = await readUntil(res, "approval.request");
    await reader.cancel();
    expect(await timeout(decision, 1000, "the approval to settle")).toBe("deny");
  });

  it("denies at once when the run is already aborted", async () => {
    const { provider, decision } = supervised();
    const { post } = setup(provider);
    const ac = new AbortController();
    ac.abort();
    await startRun(post, ac.signal).catch(() => {});
    // The provider may never start; when it does, it gets deny without waiting for the 300 s timer.
    const settled = await Promise.race([decision, new Promise((r) => setTimeout(() => r("never started"), 300))]);
    expect(["deny", "never started"]).toContain(settled);
  });
});

describe("chat completions: folder and request checks (#57)", () => {
  it("checks the server's default folder against fsRoots", async () => {
    const { chat } = setup(scripted("claude", () => [delta("x"), done()]), { openai: undefined });
    // No default cwd: the folder falls back to process.cwd(), which is not under the temp root.
    expect((await chat()).status).toBe(403);
  });

  it("refuses to start when the default folder is outside fsRoots", () => {
    const funnel = createFunnel({ providers: { claude: scripted("claude", () => [done()]) } });
    expect(() => createHandler(funnel, { fsRoots: [root], openai: { cwd: "/etc" } })).toThrow(/fsRoots/);
  });

  it("skips the folder check for providers without access levels", async () => {
    const api = scripted("ollama", () => [delta("hi"), done()], {
      capabilities: { access: [], effort: false, contextWindow: false, fast: false, resume: true, approvals: false, images: false, system: "native", schema: "native" },
    });
    const { chat, post } = setup(api, { openai: undefined });
    const res = await chat({ x_funnel: { cwd: "/etc" } }, "ollama/m1");
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("hi");
    const run = await post("/run", { selection: { provider: "ollama", model: "m1", access: "none" }, prompt: "go" });
    expect(run.status).toBe(200);
    expect(await run.text()).toContain('"type":"done"');
  });

  it.each([
    ["an empty object", {}],
    ["null messages", { model: "claude/m1", messages: null }],
    ["an empty messages array", { model: "claude/m1", messages: [] }],
    ["a message that is not an object", { model: "claude/m1", messages: ["hi"] }],
    ["a message without a role", { model: "claude/m1", messages: [{ content: "hi" }] }],
    ["a model that is not a string", { model: 5, messages: [{ role: "user", content: "hi" }] }],
    ["content parts that are not objects", { model: "claude/m1", messages: [{ role: "user", content: [null] }] }],
    ["a body that is not an object", [1, 2]],
  ])("answers 400 in the OpenAI error format for %s", async (_, body) => {
    const { post } = setup(scripted("claude", () => [done()]));
    const res = await post("/v1/chat/completions", body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toEqual(expect.any(String));
  });

  it("answers 400 for invalid JSON on every route that reads a body", async () => {
    const { post } = setup(scripted("claude", () => [done()]));
    for (const path of ["/run", "/v1/chat/completions", "/approvals/r/a", "/providers/claude/models/pull", "/providers/claude/models/delete"]) {
      expect((await post(path, "{not json")).status, path).toBe(400);
    }
  });

  it("rejects bodies over maxBodyBytes with 413", async () => {
    const { post } = setup(scripted("claude", () => [done()]), { maxBodyBytes: 200 });
    const big = JSON.stringify({ prompt: "x".repeat(500) });
    for (const path of ["/run", "/v1/chat/completions", "/approvals/r/a", "/providers/claude/models/pull", "/providers/claude/models/delete"]) {
      expect((await post(path, big)).status, path).toBe(413);
    }
    // Without content-length, the limit applies while the stream is read.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big.slice(0, 250)));
        c.enqueue(new TextEncoder().encode(big.slice(250)));
        c.close();
      },
    });
    const res = await post("/run", "", { body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    const ok = await post("/approvals/r/a", { decision: "allow" });
    expect(ok.status).toBe(200);
  });

  it("answers 413 in the OpenAI error format on chat completions", async () => {
    const { post } = setup(scripted("claude", () => [done()]), { maxBodyBytes: 100 });
    const res = await post("/v1/chat/completions", chatBody({ pad: "x".repeat(300) }));
    expect(res.status).toBe(413);
    expect((await res.json()).error.message).toMatch(/too large|limit/i);
  });

  it("allows 10 MB bodies by default", async () => {
    const { post } = setup(scripted("claude", () => [delta("ok"), done()]));
    const res = await post("/v1/chat/completions", chatBody({ pad: "x".repeat(5_000_000) }));
    expect(res.status).toBe(200);
  });
});

describe("chat completions: results (#50)", () => {
  it("puts the structured answer in content for a json_schema request", async () => {
    const provider = scripted("claude", () => [delta('Here you go: {"a":1}'), { type: "structured", data: { a: 1 } }, done()]);
    const { chat } = setup(provider);
    const rf = { response_format: { type: "json_schema", json_schema: { name: "r", schema: { type: "object" } } } };
    const res = await (await chat(rf)).json();
    expect(res.choices[0].message.content).toBe('{"a":1}');
    // Without a schema the text stays as it is.
    expect((await (await chat()).json()).choices[0].message.content).toBe('Here you go: {"a":1}');
  });

  it("streams the structured answer as one content chunk", async () => {
    const provider = scripted("claude", () => [delta("pro"), delta("se"), { type: "structured", data: { a: 1 } }, done()]);
    const { chat } = setup(provider);
    const { chunks, done: ended } = await readSse(await chat({ stream: true, response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } } }));
    expect(ended).toBe(true);
    const contents = chunks.flatMap((c) => c.choices.map((ch: { delta: { content?: string } }) => ch.delta.content)).filter((c) => c !== undefined);
    expect(contents).toEqual(['{"a":1}']);
  });

  it("streams done.text when no deltas came", async () => {
    const { chat } = setup(scripted("claude", () => [done("the answer")]));
    const { chunks } = await readSse(await chat({ stream: true }));
    expect(chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual(["the answer"]);
  });

  it("streams only the rest of done.text after deltas", async () => {
    const { chat } = setup(scripted("claude", () => [delta("the "), done("the answer")]));
    const { chunks } = await readSse(await chat({ stream: true }));
    expect(chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual(["the ", "answer"]);
    const same = setup(scripted("claude", () => [delta("same"), done("same")]));
    const again = await readSse(await same.chat({ stream: true }));
    expect(again.chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean)).toEqual(["same"]);
  });

  it("answers a bad model with an OpenAI error and a 4xx status before streaming", async () => {
    const { chat } = setup(scripted("claude", () => [done("x")]));
    const res = await chat({ stream: true }, "claude/nope");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).error.message).toMatch(/Unknown model/);
  });

  it("answers a bad access level with a 4xx status before streaming", async () => {
    const { chat } = setup(scripted("claude", () => [done("x")]));
    const res = await chat({ stream: true, x_funnel: { access: "auto" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/cannot enforce/);
  });

  it("puts usage in a final chunk with empty choices, only when asked", async () => {
    const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
    const { chat } = setup(scripted("claude", () => [delta("hi"), { type: "usage", usage }, done()]));
    const without = await readSse(await chat({ stream: true }));
    expect(without.chunks.some((c) => "usage" in c && c.usage)).toBe(false);

    const withUsage = await readSse(await chat({ stream: true, stream_options: { include_usage: true } }));
    const last = withUsage.chunks.at(-1);
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    const finishIndex = withUsage.chunks.findIndex((c) => c.choices[0]?.finish_reason === "stop");
    expect(finishIndex).toBe(withUsage.chunks.length - 2);
    expect(withUsage.chunks[finishIndex].usage).toBeUndefined();
  });

  it("reports tool calls and denied actions on streaming responses", async () => {
    const provider = scripted("claude", () => [
      { type: "tool.start", id: "t1", name: "Bash", input: { cmd: "ls" } },
      { type: "tool.end", id: "t1", error: "denied: needs approval" },
      { type: "tool.start", id: "t2", name: "Read" },
      { type: "tool.end", id: "t2", output: "ok" },
      delta("done"),
      done(),
    ]);
    const { chat } = setup(provider);
    const { chunks } = await readSse(await chat({ stream: true }));
    const finish = chunks.find((c) => c.choices[0]?.finish_reason);
    expect(finish.x_funnel.toolCalls).toEqual([
      { id: "t1", name: "Bash", input: { cmd: "ls" }, error: "denied: needs approval" },
      { id: "t2", name: "Read" },
    ]);
    expect(finish.x_funnel.deniedActions).toEqual(["Bash"]);
  });

  it("reports an error in the middle of a stream as an OpenAI error object", async () => {
    const { chat } = setup(scripted("claude", () => [delta("a"), { type: "error", message: "boom" }]));
    const { chunks } = await readSse(await chat({ stream: true }));
    expect(chunks.at(-1).error.message).toBe("boom");
  });
});

describe("chat completions: fields that are not supported (#50)", () => {
  it.each([
    ["tools", { tools: [{ type: "function", function: { name: "f" } }] }],
    ["tool_choice", { tool_choice: "required" }],
    ["n", { n: 2 }],
    ["stop", { stop: ["\n"] }],
    ["temperature", { temperature: 0.2 }],
    ["top_p", { top_p: 0.5 }],
    ["seed", { seed: 7 }],
    ["response_format", { response_format: { type: "json_object" } }],
  ])("answers 400 for %s", async (param, extra) => {
    const { chat } = setup(scripted("claude", () => [delta("x"), done()]));
    const res = await chat(extra);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.param).toBe(param);
    expect(body.error.message).toContain(param);
  });

  it("accepts the default values of those fields", async () => {
    const { chat } = setup(scripted("claude", () => [delta("x"), done()]));
    const res = await chat({ tools: [], tool_choice: "auto", n: 1, stop: null, temperature: 1, top_p: 1, response_format: { type: "text" } });
    expect(res.status).toBe(200);
    expect((await chat({ tool_choice: "none" })).status).toBe(200);
  });
});

describe("model routes (#50)", () => {
  const down = scripted("codex", () => [done()], { detect: async () => ({ installed: false, testedRange: { min: "1.0.0" } }) });
  const signedOut = scripted("agent", () => [done()], { authStatus: async () => ({ loggedIn: false }) });
  const up = scripted("claude", () => [done()]);
  const funnel = quietFunnel({ claude: up, codex: down, agent: signedOut });
  const handler = createHandler(funnel);
  const mixed = () => (path: string) => handler(new Request("http://x" + path));

  it("lists only the models of installed, signed-in providers", async () => {
    const res = await (await mixed()("/v1/models")).json();
    const ids = res.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("claude/m1");
    expect(ids.some((id: string) => id.startsWith("codex/") || id.startsWith("agent/"))).toBe(false);
  });

  it("returns one model by id", async () => {
    const res = await mixed()("/v1/models/claude/m1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "claude/m1", object: "model", owned_by: "claude" });
  });

  it("returns one model whose id has slashes or escapes", async () => {
    const sub = scripted("openai-compatible:lm" as ProviderId, () => [done()], { models: async () => [{ ...MODEL, id: "qwen/qwen3-8b", provider: "openai-compatible:lm" }] });
    const handler = createHandler(quietFunnel({ [sub.id]: sub }));
    const res = await handler(new Request("http://x/v1/models/" + encodeURIComponent("openai-compatible:lm") + "/qwen/qwen3-8b"));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe("openai-compatible:lm/qwen/qwen3-8b");
  });

  it("answers 404 in the OpenAI error format for an unknown or unavailable model", async () => {
    for (const id of ["claude/nope", "codex/m1", "agent/m1", "nope/m1"]) {
      const res = await mixed()("/v1/models/" + id);
      expect(res.status, id).toBe(404);
      expect((await res.json()).error.code).toBe("model_not_found");
    }
  });
});
