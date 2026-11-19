import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect } from "./helpers.js";
import { createFunnel } from "../src/funnel.js";
import { antigravityProvider } from "../src/providers/antigravity/index.js";
import {
  agentFacts,
  checkThought,
  createAcpMapper,
  denyPermission,
  failureFromError,
  failureFromTurn,
  initializeParams,
  limitFrom,
  modelsFromSession,
  planModel,
  sessionMeta,
  thoughtLevels,
  toUsage,
} from "../src/providers/antigravity/acp/protocol.js";
import { createRunFolder } from "../src/providers/base.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

// agy keeps its token in the home folder when the keyring is unavailable. The offline tests never need it.
vi.hoisted(() => {
  const { mkdtempSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const home = mkdtempSync(`${tmpdir()}/cf-agy-acp-home-`);
  process.env.CF_TEST_REAL_HOME = process.env.HOME ?? "";
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CACHE_HOME = `${home}/cache`;
});

/** Waits until `check` holds, for up to two seconds. The fake agent logs what the client sent a moment after the run ends. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
}

const dir = (n: string) => new URL(`./fixtures/antigravity-acp/${n}`, import.meta.url);
const json = (n: string) => JSON.parse(readFileSync(dir(n), "utf8"));
const lines = (n: string): Record<string, any>[] => readFileSync(dir(n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SESSION = "00000000-0000-4000-8000-000000000001";
const modelsText = readFileSync(new URL("./fixtures/antigravity/models.txt", import.meta.url), "utf8");

/** Runs the recorded agent messages of a turn through the mapper, the way the session does. */
function replay(n: string, access: RunInput["selection"]["access"] = "none") {
  const mapper = createAcpMapper(SESSION, { access: access! });
  const events: FunnelEvent[] = [];
  for (const m of lines(n)) {
    if (m.method === "session/update") events.push(...mapper.update(m.params.update));
    else if (m.method === "session/request_permission") mapper.refuse(m.params.toolCall.toolCallId);
    else if (m.result?.stopReason) events.push(...mapper.finish(m.result.stopReason, m.result.usage));
  }
  return events;
}

describe("antigravity ACP protocol", () => {
  const init = json("initialize.json");
  const session = json("session-new.json");

  it("reads what agy 1.5.12 advertises", () => {
    expect(agentFacts(init)).toEqual({ version: "1.5.12", resume: true, load: true, systemPrompt: true, images: true });
    expect(agentFacts(undefined)).toEqual({ version: undefined, resume: false, load: false, systemPrompt: false, images: false });
  });

  it("grants the agent nothing on the client side", () => {
    expect(initializeParams("1.0.0")).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "cli-funnel", title: "cli-funnel", version: "1.0.0" },
    });
  });

  it("sends the system prompt in _meta only when the agent takes it there", () => {
    expect(sessionMeta("Be brief.", agentFacts(init))).toEqual({ antigravity: { systemPrompt: { append: "Be brief." } } });
    expect(sessionMeta(undefined, agentFacts(init))).toBeUndefined();
    expect(sessionMeta("Be brief.", { ...agentFacts(init), systemPrompt: false })).toBeUndefined();
  });

  it("plans the model and the thinking level from the session's config options", () => {
    expect(planModel(session.configOptions, "gemini-3.8-flash", "low")).toEqual({ model: "gemini-3.8-flash", thought: "low" });
    expect(planModel(session.configOptions, "gpt-oss-120b-medium", undefined)).toEqual({ model: "gpt-oss-120b-medium" });
    // The 1.3 spelling, with the level in the id.
    expect(planModel(session.configOptions, "gemini-3.8-flash-high", undefined)).toEqual({ model: "gemini-3.8-flash", thought: "high" });
    expect(() => planModel(session.configOptions, "gemini-9", "low")).toThrow(/does not offer "gemini-9".*gemini-3\.8-flash/);
  });

  it("checks a thinking level against the current model", () => {
    expect(thoughtLevels(session.configOptions)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(() => checkThought(session.configOptions, "m", "xhigh")).not.toThrow();
    expect(() => checkThought(session.configOptions, "m", "max")).toThrow(/no thinking level "max"/);
    expect(() => checkThought([], "m", "max")).not.toThrow();
  });

  it("lists the account's models with xhigh as an effort", () => {
    const models = modelsFromSession(session.models);
    expect(models.find((m) => m.id === "gemini-4-neon")!.efforts.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(models.find((m) => m.id === "gemini-3.8-flash")!.efforts.map((e) => e.id)).toEqual(["low", "medium", "high"]);
    expect(models.find((m) => m.id === "gpt-oss-120b-medium")!.efforts).toEqual([]);
  });

  it("counts the cache in inputTokens, like every provider, and keeps the total the sum of input and output", () => {
    // agy's own `inputTokens` leaves the cache out and its `totalTokens` adds it back.
    expect(toUsage({ inputTokens: 3571, outputTokens: 4, cachedReadTokens: 16605, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 20180 })).toEqual({
      inputTokens: 20176,
      outputTokens: 4,
      cachedInputTokens: 16605,
      cacheCreationInputTokens: undefined,
      reasoningTokens: undefined,
      totalTokens: 20180,
    });
    expect(toUsage({ inputTokens: 100, outputTokens: 10, cachedReadTokens: 50, cachedWriteTokens: 20, thoughtTokens: 6, totalTokens: 180 })).toEqual({
      inputTokens: 170,
      outputTokens: 10,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 20,
      reasoningTokens: 6,
      totalTokens: 180,
    });
    expect(toUsage(undefined)).toBeUndefined();
  });

  it("reports the cache of a recorded turn as part of its input", () => {
    // Recorded: agy said inputTokens 20214, cachedReadTokens 15957, totalTokens 36346.
    expect(replay("none-denied.ndjson").find((e) => e.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 36171, outputTokens: 175, cachedInputTokens: 15957, cacheCreationInputTokens: undefined, reasoningTokens: undefined, totalTokens: 36346 },
    });
  });

  it("denies a permission request with the reject option, or cancels when there is none", () => {
    const request = lines("permission.ndjson").find((m) => m.method === "session/request_permission")!;
    expect(denyPermission(request.params)).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(denyPermission({ options: [{ optionId: "a", kind: "allow_once" }] })).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("antigravity ACP session updates", () => {
  it("streams text and ends with usage and the answer", () => {
    const events = replay("text-turn.ndjson");
    expect(events.filter((e) => e.type === "text.delta").map((e: any) => e.text)).toEqual(["2 +", " 2 is 4.\n\nBANANA"]);
    expect(events.at(-2)).toEqual({ type: "usage", usage: { inputTokens: 17999, outputTokens: 11, cachedInputTokens: undefined, cacheCreationInputTokens: undefined, reasoningTokens: undefined, totalTokens: 18010 } });
    expect(events.at(-1)).toEqual({ type: "done", text: "2 + 2 is 4.\n\nBANANA", finishReason: "stop" });
  });

  it("maps thinking to reasoning deltas", () => {
    const events = replay("resume-turn.ndjson");
    expect(events.find((e) => e.type === "reasoning.delta")).toMatchObject({ text: expect.stringContaining("secret word") });
    expect(events.at(-1)).toMatchObject({ type: "done", text: "MANGO", finishReason: "stop" });
  });

  it("reports the refusals of access none as denied tool calls", () => {
    const events = replay("none-denied.ndjson");
    expect(events.filter((e) => e.type === "tool.start").map((e: any) => e.name)).toEqual(["read_file", "run_command"]);
    const ends = events.filter((e) => e.type === "tool.end") as Extract<FunnelEvent, { type: "tool.end" }>[];
    expect(ends.map((e) => e.error)).toEqual(["denied: denied by pre-tool hook: Tools are disabled. Answer in text only.", "denied: denied by pre-tool hook: Tools are disabled. Answer in text only."]);
    const folder = createRunFolder({ prompt: "x", selection: { provider: "antigravity", model: "m", cwd: "/", access: "none" } });
    for (const e of events) folder.add(e);
    const result = folder.finish();
    expect(result.deniedActions).toEqual(["read_file", "run_command"]);
    expect(result.text).toMatch(/^ actions were blocked|^Both actions were blocked/);
    expect(result.finishReason).toBe("stop");
  });

  it("lets a tool that ran end clean, and reads a refused permission as a denial", () => {
    const events = replay("permission.ndjson", "accept-edits");
    const ends = events.filter((e) => e.type === "tool.end") as Extract<FunnelEvent, { type: "tool.end" }>[];
    expect(ends.map((e) => e.error)).toEqual([undefined, "denied: denied permission: cli-funnel does not approve tool calls on this transport."]);
    // Only the tool that was denied counts.
    const folder = createRunFolder({ prompt: "x", selection: { provider: "antigravity", model: "m", cwd: "/", access: "accept-edits" } });
    for (const e of events) folder.add(e);
    expect(folder.finish().deniedActions).toEqual(["run_command"]);
  });

  it("emits a tool end once, with the output the tool printed", () => {
    const mapper = createAcpMapper(SESSION, { access: "full" });
    const start = { sessionUpdate: "tool_call", toolCallId: "c1", name: "run_command", status: "in_progress", kind: "execute", rawInput: { CommandLine: "echo hi" } };
    const done = { ...start, sessionUpdate: "tool_call_update", status: "completed", rawOutput: { output: "hi\n" } };
    expect(mapper.update(start).map((e) => e.type)).toEqual(["tool.start"]);
    expect(mapper.update(done)).toEqual([{ type: "tool.end", id: `${SESSION}:c1`, output: "hi\n" }]);
    expect(mapper.update(done)).toEqual([]);
  });

  it("turns an ACP plan into a plan event, once per change", () => {
    const mapper = createAcpMapper(SESSION, { access: "full" });
    const plan = { sessionUpdate: "plan", entries: [{ content: "Read", priority: "high", status: "completed" }, { content: "Write", priority: "high", status: "in_progress" }] };
    expect(mapper.update(plan)).toEqual([{ type: "plan", steps: [{ text: "Read", status: "done" }, { text: "Write", status: "in_progress" }] }]);
    expect(mapper.update(plan)).toEqual([]);
  });

  it("reads the agent's task list as a plan and a plain write as a file change, as the print transport does", () => {
    // The tool calls are the shape of a live run on 1.5.12 at full: a write to task.md of the conversation, then a file in the folder.
    const brain = "/home/u/.gemini/antigravity-cli/brain";
    const mapper = createAcpMapper(SESSION, { access: "full", cwd: "/work", brainDir: brain, readText: () => "- [x] Write notes\n- [ ] Run it\n", createdInRun: () => true });
    const write = (id: string, path: string) => ({ sessionUpdate: "tool_call", toolCallId: id, name: "write_file", status: "completed", kind: "edit", rawInput: { Path: path, Content: "x", Overwrite: true } });
    expect(mapper.update(write("a", `${brain}/${SESSION}/task.md`)).map((e) => e.type)).toEqual(["tool.start", "tool.end", "plan"]);
    const events = mapper.update(write("b", "/work/notes.txt"));
    expect(events.map((e) => e.type)).toEqual(["tool.start", "tool.end", "file.change"]);
    expect(events[2]).toMatchObject({ path: "/work/notes.txt", kind: "add", status: "done" });
  });

  it("ends a cancelled turn as cancelled and a max_tokens turn as length", () => {
    expect(createAcpMapper(SESSION, { access: "none" }).finish("cancelled", undefined)).toEqual([{ type: "done", text: "", finishReason: "cancelled" }]);
    expect(createAcpMapper(SESSION, { access: "none" }).finish("max_tokens", undefined)).toEqual([{ type: "done", text: "", finishReason: "length" }]);
  });
});

// The wording of these failures comes from T3 Code's reading of agy's logs, not from a recorded run: the account here has
// quota left. They pin the parser to that wording.
describe("antigravity ACP failures", () => {
  const NOW = Date.parse("2026-11-19T12:00:00Z");

  it("reads a quota reset from the timestamp, else from the delay", () => {
    expect(limitFrom("[reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-24T08:00:00Z]", NOW)).toEqual({
      kind: "quota",
      retryAfterMs: Date.parse("2026-11-24T08:00:00Z") - NOW,
      resetAt: "2026-11-24T08:00:00.000Z",
      detail: "[reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-11-24T08:00:00Z]",
    });
    expect(limitFrom("Error 429, Message: Resource exhausted, Status: RESOURCE_EXHAUSTED [retryDelay:30s]", NOW)).toEqual({
      kind: "rate",
      retryAfterMs: 30_000,
      resetAt: "2026-11-19T12:00:30.000Z",
      detail: "Resource exhausted",
    });
    expect(limitFrom("quotaResetDelay:6h5m0s quota", NOW)).toMatchObject({ kind: "quota", retryAfterMs: 21_900_000 });
    expect(limitFrom("something else", NOW)).toBeUndefined();
  });

  it("turns a JSON-RPC error into a limit, a sign-in prompt or a plain failure", () => {
    expect(failureFromError({ code: -32603, message: "RESOURCE_EXHAUSTED: 429 too many requests" })).toMatchObject({ code: "cli-failed", limit: { kind: "rate" } });
    expect(failureFromError({ code: -32000, message: "Authentication required" })).toEqual({ message: "Run agy in a terminal and sign in.", code: "not-logged-in" });
    expect(failureFromError({ code: -32603, message: "SUBSCRIPTION_REQUIRED" }).message).toMatch(/no Antigravity subscription/);
    expect(failureFromError({ code: -32603, message: "boom" })).toEqual({ message: "boom", code: "cli-failed" });
    expect(failureFromError({ code: -32603, message: "failed", data: { status: "RESOURCE_EXHAUSTED", quotaResetDelay: "30s" } }).limit).toMatchObject({ retryAfterMs: 30_000 });
  });

  it("keeps a sign-in or subscription error that mentions a quota project out of the limits", () => {
    const adc = "Your application is authenticating by using local Application Default Credentials. The API requires a quota project, which is not set by default.";
    expect(failureFromError({ code: -32603, message: adc })).toEqual({ message: adc, code: "cli-failed" });
    expect(limitFrom(adc)).toBeUndefined();
    expect(failureFromError({ code: -32000, message: "401 Request had invalid authentication credentials. Set the quota project and sign in again." })).toEqual({ message: "Run agy in a terminal and sign in.", code: "not-logged-in" });
    expect(failureFromError({ code: -32603, message: "SUBSCRIPTION_REQUIRED: this account's quota project has no subscription" }).message).toMatch(/no Antigravity subscription/);
    // The wording of a real exhaustion is still a limit.
    expect(failureFromError({ code: -32603, message: "Quota exceeded for quota metric 'requests' and limit 'per minute'" }).limit).toMatchObject({ kind: "quota" });
    expect(failureFromError({ code: -32603, message: "You have exhausted your quota" }).limit).toMatchObject({ kind: "quota" });
  });

  it("reads the refusal stop reason as an exhausted quota", () => {
    expect(failureFromTurn("refusal", "")).toEqual({
      message: "You have reached your Antigravity quota for this period.",
      code: "cli-failed",
      limit: { kind: "quota", detail: "You have reached your Antigravity quota for this period." },
    });
    expect(failureFromTurn("end_turn", "fine")).toBeUndefined();
  });

  it("reads an API failure that agy wrote as the reply", () => {
    const failure = failureFromTurn("end_turn", "Error 429, Message: Quota exceeded for this project, Status: RESOURCE_EXHAUSTED");
    expect(failure).toMatchObject({ code: "cli-failed", limit: { kind: "quota", detail: "Quota exceeded for this project" } });
    expect(failureFromTurn("end_turn", "Error 500, Message: backend failed, Status: INTERNAL")).toEqual({ message: "backend failed", code: "cli-failed" });
    expect(failureFromTurn("end_turn", "  Error 500, Message: backend failed, Status: INTERNAL\n")).toMatchObject({ code: "cli-failed" });
  });

  it("keeps a sign-in or subscription failure that arrives as the reply classified", () => {
    expect(failureFromTurn("end_turn", "Error 401, Message: Request had invalid authentication credentials, Status: UNAUTHENTICATED")).toEqual({ message: "Run agy in a terminal and sign in.", code: "not-logged-in" });
    expect(failureFromTurn("end_turn", "Error 403, Message: SUBSCRIPTION_REQUIRED for this account, Status: PERMISSION_DENIED")).toMatchObject({ code: "cli-failed", message: expect.stringContaining("no Antigravity subscription") });
  });

  it("never reads the model's prose as a failure, even when it quotes the wording", () => {
    const quoted = "Error 500, Message: backend failed, Status: INTERNAL";
    expect(failureFromTurn("end_turn", `Here is how Google words it: ${quoted}. Handle it with a retry.`)).toBeUndefined();
    expect(failureFromTurn("end_turn", `The log says\n${quoted}\nand then stops.`)).toBeUndefined();
    expect(failureFromTurn("end_turn", `\`${quoted}\``)).toBeUndefined();
    expect(failureFromTurn("end_turn", `${quoted}, as you asked.`)).toBeUndefined();
  });

  it("keeps a successful turn successful when the answer quotes the wording", async () => {
    // Over the whole provider, not only the parser.
    expect(failureFromTurn("end_turn", "Error 429, Message: Quota exceeded, Status: RESOURCE_EXHAUSTED is what the API sends.")).toBeUndefined();
  });
});

/** A fake `agy`: `--version`, `models`, a print-style answer, and an `acp` server driven by `FAKE_ACP`. */
const FAKE = `
const fs = require("fs");
const cfg = JSON.parse(process.env.FAKE_ACP);
const log = (m) => fs.appendFileSync(cfg.log, JSON.stringify(m) + "\\n");
const [cmd] = process.argv.slice(2);
if (cmd === "--version") { console.log(cfg.version || "1.5.12"); process.exit(0); }
if (cmd === "models") { process.stdout.write(fs.readFileSync(cfg.models, "utf8")); process.exit(0); }
if (cmd !== "acp") { log({ print: process.argv.slice(2) }); console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "printed" } })); process.exit(0); }
log({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const options = JSON.parse(JSON.stringify(cfg.newResult.configOptions));
let buf = "";
let promptId;
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
function result(m, r) { out({ id: m.id, result: r }); }
function handle(m) {
  log(m);
  switch (m.method) {
    case "initialize": return result(m, cfg.initialize);
    case "session/new": return result(m, { ...cfg.newResult, sessionId: cfg.sessionId });
    case "session/resume":
      if (cfg.resumeError) return out({ id: m.id, error: { code: -32603, message: cfg.resumeError } });
      return result(m, { configOptions: options });
    case "session/set_config_option": {
      const o = options.find((x) => x.id === m.params.configId);
      o.currentValue = m.params.value;
      // Like agy: the Flash and Claude models have no extra thinking level.
      if (m.params.configId === "model") for (const t of options.filter((x) => x.category === "thought_level")) t.options = t.options.filter((x) => x.value !== "xhigh" || /neon|hydrogen/.test(m.params.value));
      return result(m, { configOptions: options });
    }
    case "session/set_mode": return result(m, {});
    case "session/cancel": if (promptId !== undefined && !cfg.ignoreCancel) out({ id: promptId, result: { stopReason: "cancelled" } }); return;
    case "session/prompt": {
      promptId = m.id;
      if (cfg.hang) return;
      if (cfg.promptError) return out({ id: m.id, error: cfg.promptError });
      let delay = 0;
      for (const line of cfg.script) {
        setTimeout(() => out(line.result && line.id !== undefined ? { ...line, id: m.id } : line), (delay += 5));
      }
      // A notification just after the last reply, as another process's output can be.
      if (cfg.lateNotification) setTimeout(() => out({ method: "x/late", params: {} }), delay + 1);
      // stderr is its own pipe, so a line written just after the last reply can arrive after it.
      if (cfg.lateStderr) setTimeout(() => process.stderr.write(cfg.lateStderr + "\\n"), delay + 2);
      return;
    }
  }
}
`;

describe.skipIf(process.platform === "win32")("antigravity over ACP, with a fake agy", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGY_BIN;
    delete process.env.FAKE_ACP;
  });

  function fakeAgy(over: Record<string, unknown> = {}, script = "text-turn.ndjson") {
    const root = mkdtempSync(join(tmpdir(), "cf-agy-acp-"));
    const bin = join(root, "agy");
    const log = join(root, "log");
    writeFileSync(bin, `#!/usr/bin/env node\n${FAKE}`);
    chmodSync(bin, 0o755);
    writeFileSync(join(root, "models.txt"), modelsText);
    process.env.CLI_FUNNEL_AGY_BIN = bin;
    process.env.FAKE_ACP = JSON.stringify({
      log,
      models: join(root, "models.txt"),
      initialize: json("initialize.json"),
      newResult: json("session-new.json"),
      sessionId: SESSION,
      script: lines(script),
      ...over,
    });
    return { root, received: () => (readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) as Record<string, any>[]) };
  }

  const input = (over: Partial<RunInput> = {}, selection: Partial<RunInput["selection"]> = {}): RunInput => ({
    prompt: "What is 2+2?",
    selection: { provider: "antigravity", model: "gemini-3.8-flash", effort: "low", cwd: tmpdir(), access: "none", ...selection },
    ...over,
  });
  const drain = async (r: RunInput) => {
    const out: FunnelEvent[] = [];
    for await (const e of antigravityProvider.run(r)) out.push(e);
    return out;
  };

  it("runs one turn: initialize, session/new, the model and level, the prompt", async () => {
    const agy = fakeAgy();
    const events = await drain(input({ system: "Be brief." }));
    expect(events.map((e) => e.type)).toEqual(["session", "text.delta", "text.delta", "usage", "done"]);
    expect(events[0]).toEqual({ type: "session", sessionId: SESSION, model: "gemini-3.8-flash" });
    expect(events.at(-1)).toMatchObject({ type: "done", text: "2 + 2 is 4.\n\nBANANA", finishReason: "stop" });
    const got = agy.received();
    expect(got[0]!.argv).toEqual(["acp", expect.stringMatching(/^--gemini-dir=.*antigravity-gemini-none$/)]);
    // `none` runs in the folder that holds the deny hook, never in the caller's folder.
    expect(got[0]!.cwd).toMatch(/workspaces[/\\]antigravity-none$/);
    const methods = got.slice(1).filter((m) => m.method).map((m) => m.method);
    expect(methods).toEqual(["initialize", "session/new", "session/set_config_option", "session/set_config_option", "session/prompt"]);
    const byMethod = (name: string) => got.filter((m) => m.method === name);
    expect(byMethod("initialize")[0]!.params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    expect(byMethod("session/new")[0]!.params).toMatchObject({ mcpServers: [], _meta: { antigravity: { systemPrompt: { append: "Be brief." } } } });
    expect(byMethod("session/set_config_option").map((m) => m.params)).toEqual([
      { sessionId: SESSION, configId: "model", value: "gemini-3.8-flash" },
      { sessionId: SESSION, configId: "thought_level", value: "low" },
    ]);
    // The system prompt went in with the session, so the prompt holds only the question.
    expect(byMethod("session/prompt")[0]!.params.prompt).toEqual([{ type: "text", text: "What is 2+2?" }]);
  });

  it("asks for the schema in the prompt and parses the reply, because ACP has no schema field", async () => {
    fakeAgy({}, "text-turn.ndjson");
    const run = input({ responseSchema: { schema: { type: "object" } } });
    const events = await drain(run);
    const result = await collect((async function* () { yield* events; })(), run);
    expect(result.structuredError).toMatch(/not JSON/);
    const agy = fakeAgy();
    await drain(run);
    const prompt = agy.received().find((m) => m.method === "session/prompt")!.params.prompt[0].text as string;
    expect(prompt).toMatch(/Reply with only a JSON value that matches this JSON Schema/);
    expect(prompt).toContain('{"type":"object"}');
  });

  it("puts the system prompt before the question when agy takes none in the session", async () => {
    const init = json("initialize.json");
    init.agentCapabilities._meta = {};
    const agy = fakeAgy({ initialize: init });
    await drain(input({ system: "Be brief." }));
    const got = agy.received();
    expect(got.find((m) => m.method === "session/new")!.params._meta).toBeUndefined();
    expect(got.find((m) => m.method === "session/prompt")!.params.prompt[0].text).toBe("<instructions>\nBe brief.\n</instructions>\n\nWhat is 2+2?");
  });

  it("denies every permission request and reports the call as denied", async () => {
    const agy = fakeAgy({}, "permission.ndjson");
    const run = input({}, { access: "accept-edits" });
    const events = await drain(run);
    // The turn wrote no text and a tool was denied, as in the print transport.
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "denied" });
    const result = await collect((async function* () { yield* events; })(), run);
    expect(result.deniedActions).toEqual(["run_command"]);
    await until(() => agy.received().some((m) => m.id === "1" && m.result));
    const answer = agy.received().find((m) => m.id === "1" && m.result);
    expect(answer!.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(agy.received().find((m) => m.method === "session/set_mode")!.params).toEqual({ sessionId: SESSION, modeId: "accept-edits" });
  });

  it("runs at none in the caller's own folder when the run has a workspaceName", async () => {
    const agy = fakeAgy();
    await drain(input({ workspaceName: "pyxis" }));
    expect(agy.received()[0]!.cwd).toMatch(/workspaces[/\\]antigravity-none\.pyxis$/);
  });

  describe("at none, keeping the user's own agy setup out", () => {
    const real = () => join(process.env.HOME!, ".gemini", "antigravity-cli");
    const dirOf = (argv: string[]) => argv.find((a) => a.startsWith("--gemini-dir="))?.slice("--gemini-dir=".length);

    it("starts agy with a private --gemini-dir that holds only a link to the data folder, so the user's MCP servers, skills and GEMINI.md are not read", async () => {
      mkdirSync(real(), { recursive: true });
      const agy = fakeAgy();
      await drain(input());
      const dir = dirOf(agy.received()[0]!.argv)!;
      expect(dir).toMatch(/antigravity-gemini-none$/);
      // The link to the data folder, and a config that is already migrated and empty, so agy has nothing to move.
      expect(readdirSync(dir).sort()).toEqual(["antigravity-cli", "config"]);
      expect(lstatSync(join(dir, "antigravity-cli")).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(dir, "antigravity-cli"))).toBe(realpathSync(real()));
    });

    it("points a stale link at the data folder again, and makes the data folder when there is none yet", async () => {
      mkdirSync(real(), { recursive: true });
      const agy = fakeAgy();
      await drain(input());
      const dir = dirOf(agy.received()[0]!.argv)!;
      rmSync(join(dir, "antigravity-cli"));
      symlinkSync(tmpdir(), join(dir, "antigravity-cli"));
      await drain(input());
      expect(realpathSync(join(dir, "antigravity-cli"))).toBe(realpathSync(real()));
      // No data folder yet: it is made, so no conversation is ever kept in the private folder.
      rmSync(join(dir, "antigravity-cli"));
      rmSync(real(), { recursive: true });
      await drain(input());
      expect(existsSync(real())).toBe(true);
      expect(realpathSync(join(dir, "antigravity-cli"))).toBe(realpathSync(real()));
    });

    it("leaves every other level on the user's own setup", async () => {
      const agy = fakeAgy();
      await drain(input({}, { access: "full" }));
      expect(dirOf(agy.received()[0]!.argv)).toBeUndefined();
    });
  });

  it("starts `agy acp` with --dangerously-skip-permissions only at full, in the caller's folder", async () => {
    const agy = fakeAgy();
    const cwd = mkdtempSync(join(tmpdir(), "cf-agy-cwd-"));
    await drain(input({}, { access: "full", cwd }));
    expect(agy.received()[0]).toMatchObject({ argv: ["acp", "--dangerously-skip-permissions"] });
    expect(agy.received()[0]!.cwd.endsWith(cwd.split("/").pop()!)).toBe(true);
  });

  it("resumes a conversation by id on a new process and runs the prompt there", async () => {
    const agy = fakeAgy({}, "resume-turn.ndjson");
    const events = await drain(input({ prompt: "What was the secret word?", sessionId: SESSION }));
    expect(events[0]).toMatchObject({ type: "session", sessionId: SESSION });
    expect(events.at(-1)).toMatchObject({ type: "done", text: "MANGO" });
    const got = agy.received();
    expect(got.find((m) => m.method === "session/resume")!.params).toMatchObject({ sessionId: SESSION, mcpServers: [] });
    expect(got.some((m) => m.method === "session/new")).toBe(false);
    // The saved selection is not trusted: the model and the level are set again.
    expect(got.filter((m) => m.method === "session/set_config_option").length).toBe(2);
  });

  it("fails a resume of a conversation agy does not have, with no session event", async () => {
    fakeAgy({ resumeError: "Failed to read session 123; retry, or load it with session/load" });
    const events = await drain(input({ sessionId: "123" }));
    expect(events).toEqual([{ type: "error", message: "Conversation 123 was not found.", code: "cli-failed" }]);
  });

  it("refuses an agy older than 1.5.0 and names the print transport", async () => {
    const init = json("initialize.json");
    init.agentInfo.version = "1.4.5";
    fakeAgy({ initialize: init });
    const events = await drain(input());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "unsupported", message: expect.stringContaining('transport "print"') });
  });

  it("refuses a model the account does not list, and a level the model does not have", async () => {
    fakeAgy();
    const model = await drain(input({}, { model: "gemini-9" }));
    expect(model[0]).toMatchObject({ type: "error", code: "invalid-selection", message: expect.stringContaining("does not offer") });
    const level = await drain(input({}, { effort: "xhigh" }));
    expect(level[0]).toMatchObject({ type: "error", code: "invalid-selection", message: expect.stringContaining('no thinking level "xhigh"') });
  });

  it("sends images as content blocks", async () => {
    const agy = fakeAgy();
    await drain(input({ attachments: [{ type: "image", mediaType: "image/png", data: "AAAA" }] }));
    expect(agy.received().find((m) => m.method === "session/prompt")!.params.prompt).toEqual([
      { type: "text", text: "What is 2+2?" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
  });

  it("refuses images on the print transport, which has no way to send them", async () => {
    fakeAgy();
    const run = input({ attachments: [{ type: "image", mediaType: "image/png", data: "AAAA" }], providerOptions: { antigravity: { transport: "print" } } });
    await expect(drain(run)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("turns a quota error of the prompt into a limit event and an error", async () => {
    fakeAgy({ promptError: { code: -32603, message: "RESOURCE_EXHAUSTED quotaResetTimeStamp:2026-11-24T08:00:00Z QUOTA_EXHAUSTED" } });
    const events = await drain(input());
    expect(events.map((e) => e.type)).toEqual(["session", "limit", "error"]);
    expect(events[1]).toMatchObject({ type: "limit", kind: "quota", resetAt: "2026-11-24T08:00:00.000Z" });
  });

  it("turns the refusal stop reason into a quota limit", async () => {
    fakeAgy({ script: [{ jsonrpc: "2.0", id: 1, result: { stopReason: "refusal" } }] });
    const events = await drain(input());
    expect(events.map((e) => e.type)).toEqual(["session", "limit", "error"]);
  });

  it("cancels the prompt when the run is aborted and ends as cancelled", async () => {
    const agy = fakeAgy({ hang: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const events = await drain(input({ signal: ac.signal }));
    expect(events.at(-1)).toEqual({ type: "done", text: "", finishReason: "cancelled" });
    expect(agy.received().some((m) => m.method === "session/cancel" && m.params.sessionId === SESSION)).toBe(true);
  });

  it("stops the process when agy ignores the cancel, without waiting for the consumer to read on", async () => {
    const agy = fakeAgy({ hang: true, ignoreCancel: true });
    process.env.CLI_FUNNEL_ACP_CANCEL_GRACE_MS = "300";
    const ac = new AbortController();
    const it = antigravityProvider.run(input({ signal: ac.signal }))[Symbol.asyncIterator]();
    try {
      expect((await it.next()).value).toMatchObject({ type: "session" });
      const pid = agy.received()[0]!.pid as number;
      ac.abort();
      // The consumer reads nothing more. The grace passes and the process must be gone anyway.
      await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      delete process.env.CLI_FUNNEL_ACP_CANCEL_GRACE_MS;
      await it.return?.(undefined);
    }
  });

  it("ends the turn after printTimeoutSec", async () => {
    const agy = fakeAgy({ hang: true });
    const events = await drain(input({ providerOptions: { antigravity: { printTimeoutSec: 0.3 } } }));
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "cancelled" });
    expect(agy.received().some((m) => m.method === "session/cancel")).toBe(true);
  });

  it("emits raw events for each line and each stderr line when verbose", async () => {
    fakeAgy();
    const events = await drain(input({ verbose: true }));
    const raw = events.filter((e) => e.type === "raw") as Extract<FunnelEvent, { type: "raw" }>[];
    expect(raw.length).toBeGreaterThan(4);
    expect(raw.every((e) => e.source === "stdout" || e.source === "stderr")).toBe(true);
  });

  describe("at none, when the hook did not apply", () => {
    const call = (id: string, name: string, status: string, extra: object = {}) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: { sessionUpdate: id.endsWith("u") ? "tool_call_update" : "tool_call", toolCallId: id.replace(/u$/, ""), name, status, kind: "execute", rawInput: { CommandLine: "touch x" }, ...extra } } });
    const text = { jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } } } };
    const result = { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } };

    it("stops the run with an error when a tool finishes, and reads nothing after it", async () => {
      fakeAgy({ script: [call("c1", "run_command", "in_progress"), call("c1u", "run_command", "completed", { rawOutput: { output: "ok" } }), text, result] });
      const events = await drain(input());
      expect(events.at(-1)).toMatchObject({ type: "error", code: "cli-failed", message: expect.stringContaining('"run_command" ran at access "none"') });
      expect(events.some((e) => e.type === "text.delta")).toBe(false);
      expect(events.some((e) => e.type === "done")).toBe(false);
    });

    it("stops the run when a tool fails with a message that is not a refusal, or starts and never ends", async () => {
      fakeAgy({ script: [call("c1", "run_command", "in_progress"), call("c1u", "run_command", "failed", { rawOutput: { output: "exit status 1" } }), text, result] });
      expect((await drain(input())).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("failed without being refused") });
      fakeAgy({ script: [call("c1", "run_command", "in_progress"), text, result] });
      const events = await drain(input());
      expect(events.at(-1)).toMatchObject({ type: "error", code: "cli-failed", message: expect.stringContaining("started and never ended") });
      expect(events.some((e) => e.type === "done")).toBe(false);
    });

    it("trusts no text a tool wrote: only the hook's own text, the permission answer, or a failure with nothing in it is a refusal", async () => {
      const failed = (extra: object) => [call("c1", "run_command", "in_progress"), call("c1u", "run_command", "failed", extra), text, result];
      const verdict = async (extra: object) => {
        fakeAgy({ script: failed(extra) });
        return (await drain(input())).at(-1)!;
      };
      // A line that starts like the hook's refusal is the tool's own, so the tool may have run.
      for (const output of ["denied by pre-tool hook: made up by the tool", "tool call denied by pre-tool hook: Tools are disabled. Answer in text only. and more", "denied permission: x"]) {
        expect(await verdict({ rawOutput: { output } }), output).toMatchObject({ type: "error", message: expect.stringContaining("failed without being refused") });
      }
      // No text, but something else in the update, an exit code: a tool that ran.
      expect(await verdict({ rawOutput: { output: "", exitCode: 1 } })).toMatchObject({ type: "error" });
      // The hook's exact text, and the shape agy gives a refusal (a failure with nothing in it, or an empty text), are refusals.
      expect(await verdict({ rawOutput: { output: "tool call denied by pre-tool hook: Tools are disabled. Answer in text only." } })).toMatchObject({ type: "done" });
      expect(await verdict({})).toMatchObject({ type: "done" });
      expect(await verdict({ rawOutput: { output: "" }, content: [{ type: "content", content: { type: "text", text: "" } }] })).toMatchObject({ type: "done" });
    });

    it("lets refused tools and finish through, and does not guard the other levels", async () => {
      const refused = [call("c1", "read_file", "in_progress"), call("c1u", "read_file", "failed"), call("c2", "finish", "in_progress"), call("c2u", "finish", "completed"), text, result];
      fakeAgy({ script: refused });
      expect((await drain(input())).at(-1)).toMatchObject({ type: "done", text: "after" });
      fakeAgy({ script: [call("c1", "run_command", "in_progress"), call("c1u", "run_command", "completed"), text, result] });
      expect((await drain(input({}, { access: "full" }))).at(-1)).toMatchObject({ type: "done", text: "after" });
    });
  });

  it("forwards a stdout line that arrives just after the final reply, before the terminal event", async () => {
    fakeAgy({ lateNotification: true });
    const events = await drain(input({ verbose: true }));
    const late = events.flatMap((e, i) => (e.type === "raw" && e.source === "stdout" && (e.data as { method?: string }).method === "x/late" ? [i] : []));
    expect(late).toHaveLength(1);
    expect(late[0]).toBeLessThan(events.findIndex((e) => e.type === "done"));
  });

  it("forwards stderr written just after the final reply, before the terminal event", async () => {
    fakeAgy({ lateStderr: "late-log-line" });
    const events = await drain(input({ verbose: true }));
    const stderr = events.flatMap((e, i) => (e.type === "raw" && e.source === "stderr" && e.data === "late-log-line" ? [i] : []));
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toBeLessThan(events.findIndex((e) => e.type === "done"));
  });

  it("masks the run's secrets in the errors it reports, also when no funnel is in between", async () => {
    // agy quotes the address of a server as the caller wrote it: percent-encoded, with the password in it.
    const url = "https://user:p%40ssword12@host.example/mcp?token=abcdefg%2Fh12";
    fakeAgy({ promptError: { code: -32603, message: `connection to ${url} failed with header-value-1` } });
    const events = await drain(input({ mcpServers: { api: { type: "http", url, headers: { "X-Custom": "header-value-1" } } } }, { access: "full" }));
    const error = events.find((e) => e.type === "error") as Extract<FunnelEvent, { type: "error" }>;
    expect(error.message).not.toMatch(/p%40ssword12|abcdefg%2Fh12|header-value-1/);
    expect(error.message).toContain("[redacted]");
  });

  it("refuses the print-only subagent options and an API key, which run on the print transport", async () => {
    fakeAgy();
    await expect(drain(input({ providerOptions: { antigravity: { forwardSubagentText: true } } }))).rejects.toMatchObject({ code: "unsupported" });
    await expect(drain(input({ providerOptions: { antigravity: { transport: "acp" } }, apiKey: "AIzaFAKEKEYFAKEKEYFAKEKEY" }))).rejects.toMatchObject({ code: "unsupported" });
  });

  it("runs an API-key run on the print transport", async () => {
    const agy = fakeAgy();
    const events = await drain(input({ apiKey: "AIzaFAKEKEYFAKEKEYFAKEKEY" }, { access: "full" }));
    expect(events.at(-1)).toMatchObject({ type: "done", text: "printed" });
    expect(agy.received().some((m) => m.print)).toBe(true);
  });

  it("rejects an unknown transport", async () => {
    fakeAgy();
    await expect(drain(input({ providerOptions: { antigravity: { transport: "http" as never } } }))).rejects.toMatchObject({ code: "invalid-selection" });
  });

  it("keeps one process and one conversation across turns with sessions.keepAlive", async () => {
    const agy = fakeAgy();
    const funnel = createFunnel({ providers: { antigravity: antigravityProvider }, sessions: { keepAlive: true } });
    const selection = { provider: "antigravity" as const, model: "gemini-3.8-flash", effort: "low", cwd: tmpdir(), access: "none" as const };
    try {
      const first = await funnel.run({ selection, prompt: "one" });
      expect(first.sessionId).toBe(SESSION);
      const second = await funnel.run({ selection, prompt: "two", sessionId: first.sessionId });
      expect(second.sessionId).toBe(SESSION);
      const got = agy.received();
      expect(got.filter((m) => m.method === "initialize")).toHaveLength(1);
      expect(got.filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text)).toEqual(["one", "two"]);
      expect(got.some((m) => m.method === "session/resume")).toBe(false);
      expect(funnel.sessions().map((s) => s.sessionId)).toEqual([SESSION]);
    } finally {
      funnel.close();
    }
  });

  it("runs a print-transport turn outside the live-session pool, so it takes no slot and evicts nothing", async () => {
    const agy = fakeAgy();
    const funnel = createFunnel({ providers: { antigravity: antigravityProvider }, sessions: { keepAlive: true, max: 1 } });
    const selection = { provider: "antigravity" as const, model: "gemini-3.8-flash", effort: "low", cwd: tmpdir(), access: "none" as const };
    try {
      const live = await funnel.run({ selection, prompt: "one" });
      expect(funnel.sessions().map((s) => s.sessionId)).toEqual([live.sessionId]);
      const printed = await funnel.run({ selection: { ...selection, access: "full" }, prompt: "two", providerOptions: { antigravity: { transport: "print" } } });
      expect(printed.text).toBe("printed");
      // The ACP session is still there, alive and listed, and still takes a turn on its own process.
      expect(funnel.sessions().map((s) => s.sessionId)).toEqual([live.sessionId]);
      await funnel.run({ selection, prompt: "three", sessionId: live.sessionId });
      expect(agy.received().filter((m) => m.method === "initialize")).toHaveLength(1);
    } finally {
      funnel.close();
    }
  });

  it("does not list models from a session: models() still comes from `agy models`", async () => {
    fakeAgy();
    const models = await antigravityProvider.models();
    expect(models.find((m) => m.id === "gemini-3.8-flash")?.efforts.length).toBeGreaterThan(0);
  });

  it("reports an agy older than 1.5.0 in detect, and lists the ACP capabilities", async () => {
    fakeAgy({ version: "1.4.5" });
    const install = await antigravityProvider.detect();
    expect(install.version).toBe("1.4.5");
    expect(install.detail).toMatch(/1\.5\.0 or newer/);
    expect(antigravityProvider.capabilities).toMatchObject({ images: true, system: "native", schema: "prompt", resume: true });
    fakeAgy();
    expect((await antigravityProvider.detect()).detail).toBeUndefined();
  });
});
