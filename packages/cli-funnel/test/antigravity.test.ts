import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect } from "../src/providers/base.js";
import { antigravityProvider, buildArgs, NONE_MATCHER, noneHooks, noneWorkspace } from "../src/providers/antigravity/index.js";
import { createMapper, parseModels } from "../src/providers/antigravity/parser.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

// agy keeps its token in the OS keyring, so no token file is the normal case. Start from a home without one, even on
// a machine where agy is signed in with a file.
vi.hoisted(() => {
  const { mkdtempSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const home = mkdtempSync(`${tmpdir()}/cf-agy-home-`);
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
  selection: { provider: "antigravity", model: "gemini-3.8-flash", effort: "low", cwd: "/tmp", access: "full", ...over },
});

describe("antigravity parser", () => {
  it("groups effort variants into base models", () => {
    const models = parseModels(fx("models.txt"));
    const flash = models.find((m) => m.id === "gemini-3.8-flash")!;
    expect(flash.efforts.map((e) => e.id)).toEqual(["low", "medium", "high"]);
    expect(models.find((m) => m.id === "gemini-3.1-pro")!.efforts.map((e) => e.id)).toEqual(["low", "high"]);
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
