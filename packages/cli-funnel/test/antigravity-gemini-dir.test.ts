import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeGeminiDir, noneGeminiDir } from "../src/providers/antigravity/index.js";
import { findBinary } from "../src/providers/base.js";

// Everything here runs under a throwaway home and cache folder, never the real ones: agy migrates its config on a first
// start in a Gemini folder, and through a link into a user's data folder that moved and re-pointed the user's `skills`.
const AGY = findBinary("agy");

/** A user's home as agy would find it, with skills in both places agy keeps them. */
function userHome(skills: "folder" | "link") {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cf-gdir-home-")));
  const config = join(home, ".gemini", "config");
  const data = join(home, ".gemini", "antigravity-cli");
  mkdirSync(join(config, "skills"), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(config, "skills", "user-skill.md"), "# user skill\n");
  writeFileSync(join(config, "mcp_config.json"), JSON.stringify({ mcpServers: {} }));
  // The user's config was migrated long ago.
  writeFileSync(join(config, ".migrated"), "");
  if (skills === "folder") {
    mkdirSync(join(data, "skills"));
    writeFileSync(join(data, "skills", "cli-skill.md"), "# cli skill\n");
  } else {
    symlinkSync(join(config, "skills"), join(data, "skills"));
  }
  return { home, config, data };
}

/** Every entry under `dir` with its kind and link target, for comparing a folder before and after. */
function tree(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    const rel = p.slice(base.length);
    if (e.isSymbolicLink()) return [`${rel} -> ${readlinkSync(p)}`];
    if (e.isDirectory()) return [`${rel}/`, ...tree(p, base)];
    return [`${rel} ${readFileSync(p, "utf8")}`];
  });
}

/** `initialize` and `session/new` on `agy acp`, under `home`, and stop. A home with no sign-in answers "Authentication required", which is enough: the migration has run by then. */
async function startSession(home: string, geminiDir: string): Promise<void> {
  const child = spawn(AGY!, ["acp", `--gemini-dir=${geminiDir}`], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CACHE_HOME: join(home, "cache") }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const answered = new Promise<void>((resolve) => {
    child.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes('"id":2')) resolve();
    });
    setTimeout(resolve, 30_000);
  });
  const send = (id: number, method: string, params: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  send(1, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  send(2, "session/new", { cwd: home, mcpServers: [] });
  await answered;
  await new Promise((r) => setTimeout(r, 1000));
  child.kill();
}

describe("the private gemini folder of a none run", () => {
  let cache: string | undefined;
  beforeEach(() => {
    cache = process.env.XDG_CACHE_HOME;
  });
  afterEach(() => {
    if (cache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = cache;
  });
  const isolate = (home: string) => {
    process.env.XDG_CACHE_HOME = join(home, "cache");
    mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });
  };

  it("is inert before agy sees it: migrated, with empty skills and an empty MCP config, so no migration runs in it", async () => {
    const { home } = userHome("folder");
    isolate(home);
    const dir = await noneGeminiDir(home);
    expect(existsSync(join(dir, "config", ".migrated"))).toBe(true);
    expect(lstatSync(join(dir, "config", "skills")).isDirectory()).toBe(true);
    expect(readdirSync(join(dir, "config", "skills"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "config", "mcp_config.json"), "utf8"))).toEqual({ mcpServers: {} });
  });

  it("replaces a skills link in it with an empty folder and leaves what the link pointed at alone", async () => {
    const { home, config } = userHome("folder");
    isolate(home);
    const dir = await noneGeminiDir(home);
    // What an earlier run, or agy, left: the private config's skills as a link to the user's.
    const skills = join(dir, "config", "skills");
    const { rmdirSync, unlinkSync } = await import("node:fs");
    rmdirSync(skills);
    symlinkSync(join(config, "skills"), skills);
    await noneGeminiDir(home);
    expect(lstatSync(skills).isSymbolicLink()).toBe(false);
    expect(readdirSync(skills)).toEqual([]);
    expect(readFileSync(join(config, "skills", "user-skill.md"), "utf8")).toBe("# user skill\n");
    void unlinkSync;
  });

  it.skipIf(!AGY || process.platform === "win32")("leaves the user's skills exactly as they were when skills is a folder", async () => {
    const { home, config, data } = userHome("folder");
    isolate(home);
    const before = [...tree(join(config, "skills")), ...tree(join(data, "skills"))];
    await startSession(home, await noneGeminiDir(home));
    expect([...tree(join(config, "skills")), ...tree(join(data, "skills"))]).toEqual(before);
    expect(lstatSync(join(data, "skills")).isDirectory()).toBe(true);
    expect(lstatSync(join(data, "skills")).isSymbolicLink()).toBe(false);
  }, 60_000);

  it.skipIf(!AGY || process.platform === "win32")("leaves the user's skills exactly as they were when skills is a link to config/skills", async () => {
    const { home, config, data } = userHome("link");
    isolate(home);
    const target = readlinkSync(join(data, "skills"));
    const before = tree(join(config, "skills"));
    await startSession(home, await noneGeminiDir(home));
    expect(readlinkSync(join(data, "skills"))).toBe(target);
    expect(tree(join(config, "skills"))).toEqual(before);
  }, 60_000);

  it("compares the link by what it resolves to, so a home reached through a link keeps its link", async () => {
    const { home } = userHome("folder");
    isolate(home);
    const alias = join(realpathSync(mkdtempSync(join(tmpdir(), "cf-alias-"))), "home");
    symlinkSync(home, alias);
    const dir = await noneGeminiDir(alias);
    const first = lstatSync(join(dir, "antigravity-cli")).ino;
    await noneGeminiDir(home);
    expect(lstatSync(join(dir, "antigravity-cli")).ino).toBe(first);
  });

  it("makes the link twice at once without failing with a raw EEXIST", async () => {
    const { home } = userHome("folder");
    isolate(home);
    const dirs = await Promise.all([noneGeminiDir(home), noneGeminiDir(home), noneGeminiDir(home)]);
    expect(new Set(dirs).size).toBe(1);
    expect(realpathSync(join(dirs[0]!, "antigravity-cli"))).toBe(realpathSync(join(home, ".gemini", "antigravity-cli")));
  });

  it("survives several processes that find a stale link together, which `makeGeminiDir` stands in for since they share no queue", async () => {
    // Without the queue the calls interleave at every await, as separate processes do. A link left pointing elsewhere makes each of them unlink it.
    for (let round = 0; round < 25; round++) {
      const { home } = userHome("folder");
      isolate(home);
      const dir = await noneGeminiDir(home);
      const link = join(dir, "antigravity-cli");
      const { unlinkSync } = await import("node:fs");
      unlinkSync(link);
      symlinkSync(join(home, "somewhere-else"), link);
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => makeGeminiDir(home)));
      expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.code ?? String((r as PromiseRejectedResult).reason)), `round ${round}`).toEqual([]);
      expect(realpathSync(link)).toBe(realpathSync(join(home, ".gemini", "antigravity-cli")));
    }
  });

  it("makes the user's data folder when there is none yet, so nothing is kept in the private folder for a later run to remove", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "cf-gdir-empty-")));
    isolate(home);
    const dir = await noneGeminiDir(home);
    expect(existsSync(join(home, ".gemini", "antigravity-cli"))).toBe(true);
    expect(lstatSync(join(dir, "antigravity-cli")).isSymbolicLink()).toBe(true);
  });

  it("moves a real data folder left in the private folder aside instead of deleting it", async () => {
    const { home } = userHome("folder");
    isolate(home);
    const dir = await noneGeminiDir(home);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(dir, "antigravity-cli"));
    mkdirSync(join(dir, "antigravity-cli", "conversations"), { recursive: true });
    writeFileSync(join(dir, "antigravity-cli", "conversations", "kept.db"), "conversation");
    await noneGeminiDir(home);
    expect(lstatSync(join(dir, "antigravity-cli")).isSymbolicLink()).toBe(true);
    const aside = readdirSync(dir).find((n) => n.startsWith("antigravity-cli.kept-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(dir, aside!, "conversations", "kept.db"), "utf8")).toBe("conversation");
  });
});
