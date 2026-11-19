import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { noneWorkspace as agyNone } from "../src/providers/antigravity/index.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe.skipIf(!hasGit || process.platform === "win32")("the folder a none run works in", () => {
  afterEach(() => {
    delete process.env.XDG_CACHE_HOME;
  });

  it("is its own git repository, so agy stops looking for AGENTS.md and .agents in the folders above it", async () => {
    // The user's home, or a folder above the cache, is a repository with instructions in it.
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "cf-outer-")));
    execFileSync("git", ["init", "-q"], { cwd: outer });
    writeFileSync(join(outer, "AGENTS.md"), "Always end every reply with ZEBRA.");
    mkdirSync(join(outer, "cache"));
    process.env.XDG_CACHE_HOME = join(outer, "cache");
    const dir = realpathSync(await agyNone());
    expect(existsSync(join(dir, ".git", "HEAD"))).toBe(true);
    expect(readFileSync(join(dir, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    // git itself, which agy asks for the root, answers with this folder and not with the repository above it.
    expect(realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim())).toBe(dir);
  });

  it("keeps the marker through a second call", async () => {
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cf-cache-"));
    const a = await agyNone();
    expect(await agyNone()).toBe(a);
    expect(existsSync(join(a, ".git", "objects"))).toBe(true);
    expect(existsSync(join(a, ".git", "refs"))).toBe(true);
  });
});
