import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNoneGuard, cursorNoneGuard } from "../src/providers/none-guard.js";
import { agentProvider } from "../src/providers/agent/index.js";
import { antigravityProvider } from "../src/providers/antigravity/index.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

const start = (id: string, name: string, extra: object = {}): FunnelEvent => ({ type: "tool.start", id, name, input: {}, ...extra });
const end = (id: string, extra: object = {}): FunnelEvent => ({ type: "tool.end", id, ...extra });

describe("the none guard", () => {
  const guard = () => createNoneGuard((name) => name !== "finish");

  it("stays quiet while every forbidden tool ends with an error, as the rules make it", () => {
    const g = guard();
    expect(g.check(start("1", "run_command"))).toBeUndefined();
    expect(g.check(end("1", { error: "denied: denied by pre-tool hook" }))).toBeUndefined();
    expect(g.check({ type: "text.delta", text: "hi" })).toBeUndefined();
  });

  it("names the tool that finished without an error", () => {
    const g = guard();
    g.check(start("1", "read_file"));
    expect(g.check(end("1", { output: "secret" }))).toMatch(/"read_file" ran at access "none".*stopped/);
  });

  it("allows what the caller allows, and ignores a subagent's calls and an end it never saw start", () => {
    const g = guard();
    g.check(start("1", "finish"));
    expect(g.check(end("1"))).toBeUndefined();
    g.check(start("2", "run_command", { parentId: "9" }));
    expect(g.check(end("2", { parentId: "9" }))).toBeUndefined();
    expect(g.check(end("unknown"))).toBeUndefined();
  });

  it("knows Cursor Agent's tools by the names its stream uses", () => {
    for (const name of ["shell", "read", "edit", "delete", "mcp", "task"]) {
      const g = cursorNoneGuard();
      g.check(start("1", name));
      expect(g.check(end("1")), name).toMatch(/ran at access "none"/);
    }
    for (const name of ["glob", "grep", "getMcpTools", "updateTodos"]) {
      const g = cursorNoneGuard();
      g.check(start("1", name));
      expect(g.check(end("1")), name).toBeUndefined();
    }
  });
});

describe.skipIf(process.platform === "win32")("Cursor Agent at none, with a CLI whose rules did not apply", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGENT_BIN;
  });

  const fx = (n: string) => readFileSync(new URL(`./fixtures/agent/${n}`, import.meta.url), "utf8").split("\n").filter(Boolean);

  it("stops the run with an error when a shell command finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agent-guard-"));
    // The recorded shell call that ran (shell-error.ndjson), then more text that must never be read.
    const lines = fx("shell-error.ndjson").filter((l) => /"type": ?"(system|tool_call)"/.test(l));
    writeFileSync(join(dir, "out.ndjson"), `${lines.join("\n")}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"after"}]}}\n`);
    const bin = join(dir, "agent");
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2026.11.13; exit 0; fi\ncat ${join(dir, "out.ndjson")}\nsleep 5\n`);
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGENT_BIN = bin;
    const run: RunInput = { selection: { provider: "agent", model: "composer-2.5", cwd: dir, access: "none" }, prompt: "hi" };
    const events: FunnelEvent[] = [];
    for await (const e of agentProvider.run(run)) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cli-failed", message: expect.stringContaining('"shell" ran at access "none"') });
    expect(events.some((e) => e.type === "text.delta" && e.text === "after")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(false);
  }, 20_000);

  it("does not stop a run at auto that runs the same command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agent-guard-"));
    const lines = fx("shell-error.ndjson").filter((l) => /"type": ?"(system|tool_call|result)"/.test(l));
    writeFileSync(join(dir, "out.ndjson"), `${lines.join("\n")}\n`);
    const bin = join(dir, "agent");
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2026.11.13; exit 0; fi\ncat ${join(dir, "out.ndjson")}\n`);
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGENT_BIN = bin;
    const events: FunnelEvent[] = [];
    for await (const e of agentProvider.run({ selection: { provider: "agent", model: "composer-2.5", cwd: dir, access: "auto" }, prompt: "hi" })) events.push(e);
    expect(events.some((e) => e.type === "error" && e.message.includes("ran at access"))).toBe(false);
  }, 20_000);
});

describe.skipIf(process.platform === "win32")("Antigravity print at none, with a hook that did not apply", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGY_BIN;
  });

  const step = (index: number, state: string, extra: object = {}) =>
    JSON.stringify({ event: "step_update", step_update: { conversation_id: "c1", step_index: index, state, step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "touch x" }, ...extra } } });

  it("stops the run when a command finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-guard-"));
    const out = [JSON.stringify({ event: "init", conversation_id: "c1", init: { model: "m", cwd: "/w" } }), step(1, "RUNNING"), step(1, "DONE", { output: "Command exited with code 0." }), JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "after" } })];
    writeFileSync(join(dir, "out.ndjson"), `${out.join("\n")}\n`);
    const bin = join(dir, "agy");
    writeFileSync(bin, `#!/bin/sh\ncat ${join(dir, "out.ndjson")}\nsleep 5\n`);
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGY_BIN = bin;
    const events: FunnelEvent[] = [];
    const run: RunInput = { selection: { provider: "antigravity", model: "m", cwd: dir, access: "none" }, prompt: "hi", providerOptions: { antigravity: { transport: "print" } } };
    for await (const e of antigravityProvider.run(run)) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cli-failed", message: expect.stringContaining('"run_command" ran at access "none"') });
    expect(events.some((e) => e.type === "done")).toBe(false);
  }, 20_000);
});
