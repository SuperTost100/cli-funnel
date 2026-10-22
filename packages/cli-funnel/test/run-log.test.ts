import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { jsonlRunLog } from "../src/run-log.js";
import { redact } from "../src/util/redact.js";
import { createHandler } from "../src/server/handler.js";
import type { FunnelEvent, Provider, RunEventRecord, RunInput } from "../src/types.js";

function provider(script: (input: RunInput) => AsyncGenerator<FunnelEvent>): Provider {
  return {
    id: "claude",
    displayName: "Fake",
    capabilities: { access: ["accept-edits", "full"], effort: true, contextWindow: false, fast: false, resume: true, approvals: false, images: false, system: "prompt", schema: "prompt" },
    detect: async () => ({ installed: true, testedRange: { min: "1.0.0" }, version: "1.0.0", withinTestedRange: true }),
    authStatus: async () => ({ loggedIn: true }),
    login: () => {
      throw new Error("no");
    },
    logout: async () => {},
    update: async () => ({ changed: false, output: "" }),
    models: async () => [{ id: "fake-1", name: "Fake 1", provider: "claude", efforts: [{ id: "high", label: "High" }], contextWindows: [], fast: false, source: "manifest" }],
    run: script,
  };
}

const happy = provider(async function* () {
  yield { type: "session", sessionId: "s1", model: "fake-1-2026" };
  yield { type: "text.delta", text: "hel" };
  yield { type: "tool.start", id: "t1", name: "Bash", input: { command: "cat ~/.ssh/id_rsa" } };
  yield { type: "tool.end", id: "t1", output: "SECRET OUTPUT", error: "denied: needs approval" };
  yield { type: "tool.start", id: "t2", name: "Read" };
  yield { type: "tool.end", id: "t2", output: "file text" };
  yield { type: "text.delta", text: "lo" };
  yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
  yield { type: "done", text: "", finishReason: "stop" };
});

const selection = { provider: "claude" as const, model: "fake-1", cwd: "/tmp", access: "accept-edits" as const, effort: "high" };
const drain = async (it: AsyncIterable<unknown>) => {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const funnelWith = (p: Provider, onEvent: (r: RunEventRecord) => unknown) => createFunnel({ providers: { claude: p }, onEvent });
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const tmp = () => join(mkdtempSync(join(tmpdir(), "cf-log-")), "runs.jsonl");

describe("onEvent", () => {
  it("sees every event with run, provider, model and time, and changes nothing", async () => {
    const records: RunEventRecord[] = [];
    const funnel = funnelWith(happy, (r) => records.push(r));
    const plain = createFunnel({ providers: { claude: happy } });
    const seen = await drain(funnel.stream({ selection, prompt: "hi" }));
    expect(seen).toEqual(await drain(plain.stream({ selection, prompt: "hi" })));
    expect(records.map((r) => r.event)).toEqual(seen);
    expect(new Set(records.map((r) => r.runId)).size).toBe(1);
    expect(records[0]).toMatchObject({ provider: "claude", model: "fake-1", prompt: "hi", selection });
    expect(records[0]!.runId).toMatch(/^run_/);
    expect(records[0]!.time).toBeGreaterThanOrEqual(records[0]!.startedAt);
  });

  it("works through funnel.run and uses a given runId", async () => {
    const records: RunEventRecord[] = [];
    const result = await funnelWith(happy, (r) => records.push(r)).run({ selection, prompt: "hi", runId: "mine" });
    expect(result.text).toBe("hello");
    expect(records.every((r) => r.runId === "mine")).toBe(true);
  });

  it("ignores a handler that throws or rejects", async () => {
    const throwing = await funnelWith(happy, () => {
      throw new Error("boom");
    }).run({ selection, prompt: "hi" });
    expect(throwing.text).toBe("hello");
    const rejecting = await funnelWith(happy, () => Promise.reject(new Error("later"))).run({ selection, prompt: "hi" });
    expect(rejecting.text).toBe("hello");
  });

  it("does not wait for a handler that never finishes", async () => {
    const result = await funnelWith(happy, () => new Promise(() => {})).run({ selection, prompt: "hi" });
    expect(result.finishReason).toBe("stop");
  });

  it("ends a run that fails before any event with an error record", async () => {
    const records: RunEventRecord[] = [];
    const funnel = funnelWith(happy, (r) => records.push(r));
    await expect(funnel.run({ selection: { ...selection, model: "nope" }, prompt: "hi" })).rejects.toThrow();
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toMatchObject({ type: "error", code: "invalid-selection" });
  });

  it("does not add a second error when the provider already sent one", async () => {
    const records: RunEventRecord[] = [];
    const failing = provider(async function* () {
      yield { type: "error", message: "api down", code: "provider" };
    });
    await funnelWith(failing, (r) => records.push(r)).run({ selection, prompt: "hi" }).catch(() => {});
    expect(records.filter((r) => r.event.type === "error")).toHaveLength(1);
  });
});

describe("jsonlRunLog", () => {
  const run = async (opts: Parameters<typeof jsonlRunLog>[1], p = happy, prompt = "hi there") => {
    const file = tmp();
    const log = jsonlRunLog(file, opts);
    await createFunnel({ providers: { claude: p }, onEvent: log }).run({ selection, prompt }).catch(() => {});
    await log.flush();
    return { file, line: lines(file)[0] };
  };

  it("writes one line per run with ids, selection, timing, usage and denied actions", async () => {
    const { file, line } = await run({});
    expect(lines(file)).toHaveLength(1);
    expect(line).toMatchObject({
      provider: "claude",
      model: "fake-1-2026",
      effort: "high",
      access: "accept-edits",
      cwd: "/tmp",
      sessionId: "s1",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      toolCalls: 2,
      tools: { Bash: 1, Read: 1 },
      deniedActions: ["Bash"],
    });
    expect(line.runId).toMatch(/^run_/);
    expect(typeof line.durationMs).toBe("number");
    expect(new Date(line.startedAt).getTime()).toBeLessThanOrEqual(new Date(line.time).getTime());
  });

  it("leaves out the prompt, the text and tool input and output by default", async () => {
    const { file } = await run({});
    const raw = readFileSync(file, "utf8");
    for (const secret of ["hi there", "hello", "id_rsa", "SECRET OUTPUT", "file text"]) expect(raw).not.toContain(secret);
  });

  it("adds the prompt and text with content, still without tool input and output", async () => {
    const { file, line } = await run({ content: true });
    expect(line).toMatchObject({ prompt: "hi there", text: "hello" });
    const raw = readFileSync(file, "utf8");
    for (const secret of ["id_rsa", "SECRET OUTPUT", "file text"]) expect(raw).not.toContain(secret);
  });

  it("logs a failed run with its error and keeps keys out of it", async () => {
    const failing = provider(async function* () {
      yield { type: "error", message: "401 for key sk-ant-api03-abcdefghijklmnop and mytoken123456", code: "auth" };
    });
    const { line } = await run({ secrets: ["mytoken123456"] }, failing);
    expect(line.finishReason).toBe("error");
    expect(line.error).toEqual({ message: "401 for key [redacted] and [redacted]", code: "auth" });
  });

  it("masks secrets in the prompt and text when content is on", async () => {
    const leaky = provider(async function* () {
      yield { type: "text.delta", text: "your token is hunter2hunter2" };
      yield { type: "done", text: "", finishReason: "stop" };
    });
    const { line } = await run({ content: true, secrets: ["hunter2hunter2"] }, leaky, "use hunter2hunter2 please");
    expect(line.prompt).toBe("use [redacted] please");
    expect(line.text).toBe("your token is [redacted]");
  });

  it("writes in the background, in the order the runs ended", async () => {
    const file = tmp();
    const log = jsonlRunLog(file);
    const ids = Array.from({ length: 20 }, (_, i) => `run_${i}`);
    for (const runId of ids) log({ runId, provider: "claude", model: "m", selection, prompt: "p", startedAt: 0, time: 1, event: { type: "done", text: "", finishReason: "stop" } });
    expect(() => statSync(file)).toThrow();
    await log.flush();
    expect(lines(file).map((r) => r.runId)).toEqual(ids);
  });

  it("keeps interleaved runs apart", async () => {
    const file = tmp();
    const log = jsonlRunLog(file);
    const funnel = createFunnel({ providers: { claude: happy }, onEvent: log });
    await Promise.all([funnel.run({ selection, prompt: "a" }), funnel.run({ selection, prompt: "b" })]);
    await log.flush();
    const rows = lines(file);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.runId)).size).toBe(2);
    expect(rows.every((r) => r.toolCalls === 2)).toBe(true);
  });

  it("creates the folder, restricts the file to its owner and survives a path it cannot write", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cf-log-")), "a", "b", "runs.jsonl");
    const log = jsonlRunLog(file);
    await createFunnel({ providers: { claude: happy }, onEvent: log }).run({ selection, prompt: "hi" });
    await log.flush();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const blocker = tmp();
    writeFileSync(blocker, "");
    const errors: Error[] = [];
    const blocked = jsonlRunLog(join(blocker, "x.jsonl"), { onError: (e) => errors.push(e) });
    const result = await createFunnel({ providers: { claude: happy }, onEvent: blocked }).run({ selection, prompt: "hi" });
    await blocked.flush();
    expect(result.text).toBe("hello");
    expect(errors).toHaveLength(1);
  });

  it("uses the id the server sends to the client", async () => {
    const file = tmp();
    const log = jsonlRunLog(file);
    const funnel = createFunnel({ providers: { claude: happy }, onEvent: log });
    const handler = createHandler(funnel, { fsRoots: [tmpdir()] });
    const res = await handler(new Request("http://127.0.0.1/run", { method: "POST", headers: { host: "127.0.0.1" }, body: JSON.stringify({ selection: { ...selection, cwd: tmpdir() }, prompt: "go" }) }));
    const body = await res.text();
    const runId = /"runId":"([^"]+)"/.exec(body)![1];
    await log.flush();
    expect(lines(file)[0].runId).toBe(runId);
  });
});

describe("redact", () => {
  it("masks given secrets and common key shapes, and ignores short secrets", () => {
    expect(redact("a Bearer abcdefghijklmnopqrstuv b")).toBe("a Bearer [redacted] b");
    expect(redact("key AIzaSyA1234567890abcdefghijklmnopqrstuv")).toBe("key [redacted]");
    expect(redact("short abc here", ["abc"])).toBe("short abc here");
    expect(redact("one longsecret1 two", ["longsecret1", undefined])).toBe("one [redacted] two");
  });
});
