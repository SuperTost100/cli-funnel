import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProvider } from "../src/providers/claude/index.js";

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-logout-"));
  const file = join(dir, "claude");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("logout and update report CLI failures", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_CLAUDE_BIN;
  });

  it("rejects logout and update with cli-failed when the CLI exits non-zero", async () => {
    process.env.CLI_FUNNEL_CLAUDE_BIN = script(
      `case "$*" in\n  "--version") echo "2.1.0 (Claude Code)" ;;\n  "auth logout"|"update") echo boom >&2; exit 1 ;;\nesac`,
    );
    await expect(claudeProvider.logout()).rejects.toMatchObject({ code: "cli-failed", message: expect.stringContaining("boom") });
    await expect(claudeProvider.update()).rejects.toMatchObject({ code: "cli-failed", message: expect.stringContaining("boom") });
  });

  it("resolves logout and update when the CLI exits 0", async () => {
    process.env.CLI_FUNNEL_CLAUDE_BIN = script(
      `case "$*" in\n  "--version") echo "2.1.0 (Claude Code)" ;;\n  "auth logout"|"update") exit 0 ;;\nesac`,
    );
    await expect(claudeProvider.logout()).resolves.toBeUndefined();
    await expect(claudeProvider.update()).resolves.toMatchObject({ changed: false, from: "2.1.0", to: "2.1.0" });
  });
});
