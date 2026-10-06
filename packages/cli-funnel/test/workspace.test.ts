import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownedWorkspace } from "../src/util/workspace.js";

describe("ownedWorkspace", () => {
  const old = process.env.XDG_CACHE_HOME;
  beforeEach(() => {
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "cf-cache-"));
  });
  afterEach(() => {
    if (old === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = old;
  });

  it("creates a private folder under the cache dir with only the given files", async () => {
    const dir = await ownedWorkspace("t", { "a/b.json": "{}\n" });
    expect(dir).toBe(join(process.env.XDG_CACHE_HOME!, "cli-funnel", "workspaces", "t"));
    expect(readFileSync(join(dir, "a", "b.json"), "utf8")).toBe("{}\n");
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("rewrites changed files and leaves no temp files behind under concurrency", async () => {
    await ownedWorkspace("t", { "x.json": "old" });
    await Promise.all(Array.from({ length: 8 }, () => ownedWorkspace("t", { "x.json": "new" })));
    const dir = join(process.env.XDG_CACHE_HOME!, "cli-funnel", "workspaces", "t");
    expect(readFileSync(join(dir, "x.json"), "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });
});
