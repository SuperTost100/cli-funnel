import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentProvider } from "../src/providers/agent/index.js";
import { antigravityProvider } from "../src/providers/antigravity/index.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

// A git variable in the caller's environment would send the CLI to another repository, past the marker of the `none` folder.
describe.skipIf(process.platform === "win32")("git variables at access none", () => {
  beforeEach(() => {
    process.env.GIT_DIR = "/elsewhere/.git";
    process.env.GIT_WORK_TREE = "/elsewhere";
  });
  afterEach(() => {
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    delete process.env.CLI_FUNNEL_AGY_BIN;
    delete process.env.CLI_FUNNEL_AGENT_BIN;
  });

  /** A CLI that writes the two variables it sees to a file and answers with an empty result. */
  const fake = (name: string, answer: string) => {
    const dir = mkdtempSync(join(tmpdir(), "cf-git-env-"));
    const seen = join(dir, "seen");
    const bin = join(dir, name);
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2026.11.13; exit 0; fi\nprintf '%s|%s' "\${GIT_DIR-unset}" "\${GIT_WORK_TREE-unset}" > ${seen}\ncat <<'EOF2'\n${answer}\nEOF2\n`);
    chmodSync(bin, 0o755);
    return { dir, bin, seen: () => readFileSync(seen, "utf8") };
  };
  const drain = async (events: AsyncIterable<FunnelEvent>) => {
    for await (const _ of events) void _;
  };

  it("are removed for Antigravity print and kept at auto", async () => {
    const f = fake("agy", JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }));
    process.env.CLI_FUNNEL_AGY_BIN = f.bin;
    const run = (access: "none" | "auto"): RunInput => ({ selection: { provider: "antigravity", model: "m", cwd: f.dir, access }, prompt: "hi", providerOptions: { antigravity: { transport: "print" } } });
    await drain(antigravityProvider.run(run("none")));
    expect(f.seen()).toBe("unset|unset");
    await drain(antigravityProvider.run(run("auto")));
    expect(f.seen()).toBe("/elsewhere/.git|/elsewhere");
  }, 20_000);

  it("are removed for Cursor Agent and kept at auto", async () => {
    const f = fake("agent", JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s" }));
    process.env.CLI_FUNNEL_AGENT_BIN = f.bin;
    const run = (access: "none" | "auto"): RunInput => ({ selection: { provider: "agent", model: "composer-2.5", cwd: f.dir, access }, prompt: "hi" });
    await drain(agentProvider.run(run("none")));
    expect(f.seen()).toBe("unset|unset");
    await drain(agentProvider.run(run("auto")));
    expect(f.seen()).toBe("/elsewhere/.git|/elsewhere");
  }, 20_000);
});
