import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeNodeCli, fakeShCli, sh } from "./fake-cli.js";
import { collect } from "./helpers.js";
import { antigravityProvider, buildArgs, NONE_MATCHER, noneHooks, noneWorkspace } from "../src/providers/antigravity/index.js";
import { createMapper, parseModels, parseWarning } from "../src/providers/antigravity/parser.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

// agy keeps its token in the OS keyring, so no token file is the normal case. Start from a home without one, even on
// a machine where agy is signed in with a file.
vi.hoisted(() => {
  const { mkdtempSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const home = mkdtempSync(`${tmpdir()}/cf-agy-home-`);
  // The live tests need the real home: agy reads its sign-in from it when the keyring is unavailable.
  process.env.CF_TEST_REAL_HOME = process.env.HOME ?? "";
  process.env.CF_TEST_REAL_USERPROFILE = process.env.USERPROFILE ?? "";
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

const fx = (n: string) => readFileSync(new URL(`./fixtures/antigravity/${n}`, import.meta.url), "utf8");
const events = (n: string): FunnelEvent[] => {
  const m = createMapper();
  return fx(n).split("\n").filter(Boolean).flatMap((l) => m.map(JSON.parse(l)));
};
const input = (over: Partial<RunInput["selection"]> = {}): RunInput => ({
  prompt: "hi",
  selection: { provider: "antigravity", model: "gemini-3.8-flash", effort: "low", cwd: tmpdir(), access: "full", ...over },
});

describe("antigravity access.reduced", () => {
  const init = (access: RunInput["selection"]["access"], permission_mode?: string) =>
    createMapper({ access }).map({ event: "init", conversation_id: "c", init: { model: "m", cwd: "/w", permission_mode } }).map((e) => e.type);
  const reduced = (permission_mode: string) =>
    createMapper({ access: "full" }).map({ event: "init", conversation_id: "c", init: { permission_mode } })[1];

  it("reports a start that is not always-proceed at full", () => {
    expect(init("full", "request-review")).toEqual(["session", "access.reduced"]);
    expect(reduced("request-review")).toEqual({ type: "access.reduced", access: "full", expected: "always-proceed", started: "request-review" });
  });

  it("reports nothing at full with always-proceed or no field, or at the levels it cannot tell apart", () => {
    expect(init("full", "always-proceed")).toEqual(["session"]);
    expect(init("full")).toEqual(["session"]);
    expect(init("accept-edits", "request-review")).toEqual(["session"]);
    expect(init("none", "proceed-in-sandbox")).toEqual(["session"]);
  });
});

describe("antigravity parser", () => {
  it("groups effort variants into base models", () => {
    const models = parseModels(fx("models.txt"));
    const flash = models.find((m) => m.id === "gemini-3.8-flash")!;
    expect(flash.efforts.map((e) => e.id)).toEqual(["low", "medium", "high"]);
    expect(parseModels("m-high\tM (High)\nm-low\tM (Low)\n")[0]!.efforts.map((e) => e.id)).toEqual(["low", "high"]);
    expect(models.find((m) => m.id === "claude-sonnet-4-6")!.efforts).toEqual([]);
    expect(models.find((m) => m.id === "gpt-oss-120b-medium")!.efforts).toEqual([]);
  });

  it("maps a simple run", async () => {
    const r = await collect((async function* () { yield* events("simple.ndjson"); })(), input());
    expect(r.text).toBe("OK\n");
    expect(r.sessionId).toBeTruthy();
    expect(r.usage?.totalTokens).toBe(13453);
  });

  it("maps a tool call", () => {
    const e = events("tool.ndjson");
    expect(e.some((x) => x.type === "tool.start" && x.name === "write_to_file")).toBe(true);
    expect(e.some((x) => x.type === "tool.end" && !x.error)).toBe(true);
  });

  it("reports denied tools", async () => {
    const e = events("denied.ndjson");
    const denied = e.filter((x) => x.type === "tool.end" && x.error?.startsWith("denied:"));
    expect(denied).toHaveLength(1);
    expect(e.at(-1)).toMatchObject({ type: "done", finishReason: "denied" });
  });

  it("reports tools refused by a hook as denied", async () => {
    const e = events("none-denied.ndjson");
    expect(e.find((x) => x.type === "tool.end")).toMatchObject({ error: expect.stringMatching(/^denied: tool call denied by pre-tool hook/) });
    const r = await collect((async function* () { yield* e; })(), input({ access: "none" }));
    expect(r.deniedActions).toEqual(["run_command"]);
    expect(r.finishReason).toBe("stop");
    expect(r.text).toMatch(/done/);
  });

  it("maps CLI errors", () => {
    expect(events("error.ndjson")[0]).toMatchObject({ type: "error", code: "cli-failed" });
  });

  it("builds args", () => {
    const args = buildArgs(input({ access: "accept-edits" }));
    expect(args).toEqual(expect.arrayContaining(["--model", "gemini-3.8-flash", "--effort", "low", "--mode", "accept-edits"]));
    expect(buildArgs(input({ access: "full" }), [])).toContain("--dangerously-skip-permissions");
    const none = buildArgs(input({ access: "none" }));
    expect(none).not.toContain("--mode");
    expect(none).not.toContain("--dangerously-skip-permissions");
  });
});

describe("antigravity none", () => {
  it("offers none", () => {
    expect(antigravityProvider.capabilities.access).toEqual(["none", "accept-edits", "full"]);
  });

  it("matches every tool except finish", () => {
    const re = new RegExp(NONE_MATCHER);
    for (const t of ["run_command", "write_to_file", "view_file", "call_mcp_tool", "invoke_subagent", "fin", "f", "finished", "finish_task", "x"]) {
      expect(re.test(t), t).toBe(true);
    }
    expect(re.test("finish")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("hook command prints a deny decision", () => {
    const hook = (noneHooks("linux")["cli-funnel-none"] as any).PreToolUse[0].hooks[0];
    const out = execFileSync("sh", ["-c", hook.command], { input: JSON.stringify({ toolCall: { name: "run_command" } }), encoding: "utf8" });
    expect(JSON.parse(out)).toEqual({ decision: "deny", reason: "Tools are disabled. Answer in text only." });
  });

  it("uses echo under cmd on Windows", () => {
    const hook = (noneHooks("win32")["cli-funnel-none"] as any).PreToolUse[0].hooks[0];
    expect(hook.command).toBe('echo {"decision":"deny","reason":"Tools are disabled. Answer in text only."}');
  });

  it("writes only the hook file to its workspace", async () => {
    const old = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cf-cache-"));
    try {
      const dir = await noneWorkspace();
      expect(readdirSync(dir)).toEqual([".agents"]);
      expect(JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf8"))).toEqual(noneHooks());
    } finally {
      if (old === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = old;
    }
  });
});

describe.skipIf(process.platform === "win32")("antigravity long schema", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGY_BIN;
  });

  it("passes a 200 KB schema as a private file and removes it after the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    const bin = join(dir, "agy");
    const log = join(dir, "log");
    // Records the --json-schema value, the file's size and the folder's mode, then answers.
    writeFileSync(
      bin,
      `#!/bin/sh\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "--json-schema" ]; then echo "$a" > ${log}; wc -c < "$a" >> ${log}; { stat -c %a "$(dirname "$a")" || stat -f %Lp "$(dirname "$a")"; } >> ${log}; fi\n  prev="$a"\ndone\necho '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'\n`,
    );
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGY_BIN = bin;
    const schema = { type: "object", properties: { text: { type: "string", description: "x".repeat(200_000) } } };
    const run: RunInput = { selection: { provider: "antigravity", model: "m", cwd: dir, access: "full" }, prompt: "hi", responseSchema: { schema } };
    for await (const _ of antigravityProvider.run(run)) {
      /* drain */
    }
    const [path, size, mode] = readFileSync(log, "utf8").trim().split("\n");
    expect(Number(size)).toBe(JSON.stringify(schema).length);
    expect(mode).toBe("700");
    expect(existsSync(path!)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("antigravity verbose", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGY_BIN;
  });

  const runWith = async (verbose?: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    const bin = join(dir, "agy");
    writeFileSync(bin, `#!/bin/sh\necho "warming up" >&2\necho 'not json'\necho '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'\n`);
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGY_BIN = bin;
    const events: FunnelEvent[] = [];
    for await (const e of antigravityProvider.run({ selection: { provider: "antigravity", model: "m", cwd: dir, access: "full" }, prompt: "hi", verbose })) events.push(e);
    return events;
  };

  it("emits stdout and stderr lines as raw events before the terminal event", async () => {
    const events = await runWith(true);
    const raw = events.filter((e) => e.type === "raw");
    expect(raw.filter((e) => e.source === "stdout").map((e) => e.data)).toEqual(["not json", { event: "result", result: { status: "SUCCESS", response: "ok" } }]);
    expect(raw.filter((e) => e.source === "stderr")).toEqual([{ type: "raw", provider: "antigravity", source: "stderr", data: "warming up" }]);
    expect(events.at(-1)).toMatchObject({ type: "done", text: "ok" });
  });

  it("emits no raw events without verbose", async () => {
    expect((await runWith()).some((e) => e.type === "raw")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("antigravity sign-in", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGY_BIN;
  });

  /** A fake agy. `models` prints the fixture when `ok` exists in its folder, otherwise it fails with `failure`. */
  function fakeAgy(failure = `echo "Error: Please sign in to view available models" >&2; exit 1`) {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    const bin = join(dir, "agy");
    const calls = join(dir, "calls");
    const models = join(dir, "models.txt");
    writeFileSync(models, fx("models.txt"));
    writeFileSync(
      bin,
      `#!/bin/sh\n[ "$1" = "models" ] || exit 2\necho x >> ${calls}\nsleep 0.3\nif [ -f ${join(dir, "ok")} ]; then cat ${models}; exit 0; fi\n${failure}\n`,
    );
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGY_BIN = bin;
    return { signIn: () => writeFileSync(join(dir, "ok"), ""), calls: () => readFileSync(calls, "utf8").trim().split("\n").length };
  }

  it("is signed in when models works and there is no token file", async () => {
    fakeAgy().signIn();
    expect(existsSync(join(process.env.HOME!, ".gemini", "antigravity-cli", "antigravity-oauth-token"))).toBe(false);
    expect(await antigravityProvider.authStatus()).toEqual({ loggedIn: true, method: "Google account" });
  });

  it("is signed out when models asks for a sign-in", async () => {
    fakeAgy();
    expect(await antigravityProvider.authStatus()).toEqual({ loggedIn: false, detail: "Run agy in a terminal and sign in." });
  });

  it("reports a failure that is not a sign-in prompt as such", async () => {
    fakeAgy(`echo "panic: boom" >&2; exit 2`);
    const status = await antigravityProvider.authStatus();
    expect(status.loggedIn).toBe(false);
    expect(status.detail).toBe("agy exited with code 2. panic: boom");
  });

  it("runs one models check at a time", async () => {
    const agy = fakeAgy();
    agy.signIn();
    const all = await Promise.all([antigravityProvider.authStatus(), antigravityProvider.authStatus(), antigravityProvider.authStatus()]);
    expect(all.every((s) => s.loggedIn)).toBe(true);
    expect(agy.calls()).toBe(1);
    await antigravityProvider.authStatus();
    expect(agy.calls()).toBe(2);
  });

  it("login finishes once agy starts working", async () => {
    const agy = fakeAgy();
    setTimeout(agy.signIn, 500);
    const events = [];
    for await (const e of antigravityProvider.login()) events.push(e);
    expect(events).toEqual([
      { type: "needs-terminal", command: ["agy"] },
      { type: "done", status: { loggedIn: true, method: "Google account" } },
    ]);
  }, 15_000);
});

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1")("antigravity live", () => {
  let fake: { home?: string; profile?: string } = {};
  beforeAll(() => {
    fake = { home: process.env.HOME, profile: process.env.USERPROFILE };
    process.env.HOME = process.env.CF_TEST_REAL_HOME;
    process.env.USERPROFILE = process.env.CF_TEST_REAL_USERPROFILE;
  });
  afterAll(() => {
    process.env.HOME = fake.home;
    process.env.USERPROFILE = fake.profile;
  });

  it("answers a tiny prompt", async () => {
    const r = await collect(
      antigravityProvider.run({ ...input({ cwd: "/tmp", model: "gemini-3.8-flash", effort: "low" }), prompt: "Reply with the word OK" }),
      input(),
    );
    expect(r.text).toMatch(/OK/);
    expect((await antigravityProvider.authStatus()).loggedIn).toBe(true);
  }, 90_000);

  it("none answers and blocks a shell write", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "cf-agy-none-")), "out.txt");
    const run = { ...input({ access: "none" }), prompt: `Run the shell command "touch ${target}", then reply "done".` };
    const r = await collect(antigravityProvider.run(run), run);
    expect(existsSync(target)).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
  }, 120_000);
});

describe.skipIf(process.platform === "win32")("antigravity default effort", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGY_BIN;
  });

  it("takes the default effort from the listed models, not only the bundled manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    const bin = join(dir, "agy");
    const log = join(dir, "args");
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = "models" ]; then printf 'new-model-low\\tNew (Low)\\nnew-model-high\\tNew (High)\\n'; exit 0; fi\necho "$@" > ${log}\necho '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'\n`,
    );
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGY_BIN = bin;
    expect((await antigravityProvider.models()).find((m) => m.id === "new-model")?.defaultEffort).toBe("high");
    const run: RunInput = { selection: { provider: "antigravity", model: "new-model", cwd: dir, access: "full" }, prompt: "hi" };
    for await (const _ of antigravityProvider.run(run)) {
      /* drain */
    }
    expect(readFileSync(log, "utf8")).toContain("--effort high");
  });
});

describe("antigravity warnings", () => {
  it("reads a warning from a stderr line that starts with `warning: `", () => {
    expect(parseWarning('warning: conversation "nonexistent-id" not found')).toBe('conversation "nonexistent-id" not found');
    expect(parseWarning("warning: --mode plan has no effect while slash command expansion is disabled.")).toBe("--mode plan has no effect while slash command expansion is disabled.");
    expect(parseWarning('warning: unrecognized --mode value "x" (valid: accept-edits, auto, plan)')).toBe('unrecognized --mode value "x" (valid: accept-edits, auto, plan)');
    expect(parseWarning('warning: ignoring unsupported stream input message event "bogus"')).toBe('ignoring unsupported stream input message event "bogus"');
    expect(parseWarning("warning:   padded  ")).toBe("padded");
  });

  it("reads nothing from the other prefixes, an empty warning or a warning in the middle of a line", () => {
    for (const line of ["error: boom", 'jetski: no output produced', "[agy] starting", "AGY_ERROR: boom", "warning:", "warning: ", "Warning: x", "see warning: x", ""]) {
      expect(parseWarning(line)).toBeUndefined();
    }
  });

  /** A fake agy that prints `stderr` first and then a normal run, on `conversation_id` `reported`. Logs its arguments. */
  function fakeAgy(stderr: string, reported = "c1") {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    const log = join(dir, "args");
    process.env.CLI_FUNNEL_AGY_BIN = fakeShCli(
      join(dir, "agy"),
      `for a in "$@"; do echo "$a" >> "${sh(log)}"; done
${stderr}
echo '{"event":"init","conversation_id":"${reported}","init":{"model":"m","cwd":"/w","permission_mode":"always-proceed"}}'
echo '{"event":"step_update","step_update":{"conversation_id":"${reported}","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"ok"}}'
echo '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'`,
    );
    return { dir, args: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
  }
  const drain = async (r: RunInput) => {
    const out: FunnelEvent[] = [];
    for await (const e of antigravityProvider.run(r)) out.push(e);
    return out;
  };
  const types = (events: FunnelEvent[]) => events.map((e) => e.type);
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGY_BIN;
  });

  it("emits a stderr warning right after session and keeps it in the result", async () => {
    fakeAgy(`echo 'warning: --mode plan has no effect while slash command expansion is disabled.' >&2
echo 'jetski: not a warning' >&2`);
    const run = input();
    const events = await drain(run);
    expect(types(events)).toEqual(["session", "warning", "text.delta", "done"]);
    expect(events[1]).toEqual({ type: "warning", message: "--mode plan has no effect while slash command expansion is disabled." });
    expect((await collect(antigravityProvider.run(run), run)).warnings).toEqual(["--mode plan has no effect while slash command expansion is disabled."]);
  });

  it("puts the warning after access.reduced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    process.env.CLI_FUNNEL_AGY_BIN = fakeShCli(
      join(dir, "agy"),
      `echo 'warning: a' >&2
echo '{"event":"init","conversation_id":"c1","init":{"model":"m","cwd":"/w","permission_mode":"request-review"}}'
echo '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'`,
    );
    expect(types(await drain(input()))).toEqual(["session", "access.reduced", "warning", "done"]);
  });

  it("masks the run's secrets in a warning", async () => {
    fakeAgy(`echo 'warning: key sk-secret-1234 rejected' >&2`);
    const events = await drain({ ...input(), apiKey: "sk-secret-1234" });
    const warning = events.find((e) => e.type === "warning");
    expect(warning).toMatchObject({ type: "warning" });
    expect(JSON.stringify(warning)).not.toContain("sk-secret-1234");
  });

  it("emits a warning that the run has no session for just before the terminal event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    process.env.CLI_FUNNEL_AGY_BIN = fakeShCli(join(dir, "agy"), `echo 'warning: early' >&2
echo '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'`);
    expect(types(await drain(input()))).toEqual(["warning", "done"]);
  });

  it("emits a warning that arrives after the session before the next line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    process.env.CLI_FUNNEL_AGY_BIN = fakeShCli(
      join(dir, "agy"),
      `echo '{"event":"init","conversation_id":"c1","init":{"model":"m","cwd":"/w","permission_mode":"always-proceed"}}'
sleep 0.2
echo 'warning: late' >&2
sleep 0.2
echo '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"ok"}}'
echo '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'`,
    );
    expect(types(await drain(input()))).toEqual(["session", "warning", "text.delta", "done"]);
  });

  it("emits a held warning before the error of a run that exits without a result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    process.env.CLI_FUNNEL_AGY_BIN = fakeShCli(join(dir, "agy"), `echo 'warning: before exit' >&2
exit 3`);
    const events = await drain(input());
    expect(types(events)).toEqual(["warning", "error"]);
  });

  it("emits a warning with no line break that is written before the result, also when the process lingers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    process.env.CLI_FUNNEL_AGY_BIN = fakeNodeCli(
      join(dir, "agy"),
      `process.stderr.write("warning: unterminated");
process.stdout.write('{"event":"init","conversation_id":"c1","init":{"model":"m","cwd":"/w","permission_mode":"always-proceed"}}\\n');
process.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\\n');
setInterval(() => {}, 1000);`,
    );
    const events = await drain(input());
    expect(types(events)).toEqual(["session", "warning", "done"]);
    expect(events[1]).toEqual({ type: "warning", message: "unterminated" });
  });
});

describe("antigravity resume", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGY_BIN;
  });
  const fake = (reported: string, stderr = "") => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    process.env.CLI_FUNNEL_AGY_BIN = fakeShCli(
      join(dir, "agy"),
      `${stderr}
echo '{"event":"init","conversation_id":"${reported}","init":{"model":"m","cwd":"/w"}}'
echo '{"event":"step_update","step_update":{"conversation_id":"${reported}","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"after"}}'
echo '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'`,
    );
  };
  const drain = async (r: RunInput) => {
    const out: FunnelEvent[] = [];
    for await (const e of antigravityProvider.run(r)) out.push(e);
    return out;
  };

  it("fails a resume that started a new conversation, with no session event and nothing after the error", async () => {
    fake("other-id", `echo 'warning: conversation "abc" not found' >&2`);
    const events = await drain({ ...input(), sessionId: "abc" });
    expect(events.map((e) => e.type)).toEqual(["warning", "error"]);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cli-failed", message: expect.stringContaining("abc") });
    expect((events.at(-1) as { message: string }).message).toMatch(/not found.*new conversation/i);
  });

  it("stops the CLI at once when a resume started a new conversation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    const pidFile = join(dir, "pid");
    process.env.CLI_FUNNEL_AGY_BIN = fakeNodeCli(
      join(dir, "agy"),
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log('{"event":"init","conversation_id":"other-id","init":{"model":"m","cwd":"/w"}}');
setInterval(() => {}, 1000);`,
    );
    const events = await drain({ ...input(), sessionId: "abc" });
    expect(events.map((e) => e.type)).toEqual(["error"]);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("resumes when init reports the conversation that was asked for", async () => {
    fake("abc");
    const events = await drain({ ...input(), sessionId: "abc" });
    expect(events[0]).toMatchObject({ type: "session", sessionId: "abc" });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("takes any conversation id when the run is not a resume", async () => {
    fake("other-id");
    expect((await drain(input()))[0]).toMatchObject({ type: "session", sessionId: "other-id" });
  });
});
