import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childEnv, loginShellPath, resolveBinary } from "../src/util/process.js";

const saved = { SHELL: process.env.SHELL, PATH: process.env.PATH };

function fakeShell(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-shell-"));
  const file = join(dir, "sh");
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return file;
}

afterEach(() => {
  process.env.SHELL = saved.SHELL;
  process.env.PATH = saved.PATH;
  loginShellPath(true);
});

describe.skipIf(process.platform === "win32")("login shell PATH", () => {
  it("finds a CLI that only the login shell's PATH has", () => {
    const bin = mkdtempSync(join(tmpdir(), "cf-bin-"));
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "cf-only-in-shell"), "#!/bin/sh\n");
    chmodSync(join(bin, "cf-only-in-shell"), 0o755);
    // rc noise before the marker must be ignored.
    process.env.SHELL = fakeShell(`echo "welcome"; echo __CLI_FUNNEL_ENV__; echo "PATH=${bin}:/usr/bin"; echo __CLI_FUNNEL_ENV__`);
    process.env.PATH = "/usr/bin:/bin";
    loginShellPath(true);
    expect(resolveBinary("cf-only-in-shell")).toBe(join(bin, "cf-only-in-shell"));
    expect(childEnv().PATH?.split(":")).toContain(bin);
    expect(childEnv().PATH?.startsWith("/usr/bin:/bin")).toBe(true);
  });

  it("falls back to the process PATH when the shell fails", () => {
    process.env.SHELL = fakeShell("exit 1");
    expect(loginShellPath(true)).toEqual([]);
  });
});
