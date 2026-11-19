import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";

// Two model calls per tool: one saved run as the control, one with persist: false. On the cheapest model of each tool.
const LIVE = process.env.CLI_FUNNEL_LIVE === "1" && process.platform !== "win32";
const funnel = createFunnel();

/** Every file under `dir` whose name holds `needle`. */
function find(dir: string, needle: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(join(dir, e.name), needle) : e.name.includes(needle) ? [join(dir, e.name)] : []));
}

describe.skipIf(!LIVE)("persist: false, live", () => {
  it("Claude Code writes no session file", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "cf-persist-claude-")));
    const selection = { provider: "claude" as const, model: "claude-haiku-5-5", effort: "low", cwd, access: "none" as const };
    const saved = await funnel.run({ selection, prompt: "Reply with the single word OK." });
    const unsaved = await funnel.run({ selection, prompt: "Reply with the single word OK.", persist: false });
    const projects = join(homedir(), ".claude", "projects");
    expect(find(projects, saved.sessionId!)).not.toEqual([]);
    expect(find(projects, unsaved.sessionId!)).toEqual([]);
  }, 180_000);

  it("Codex writes no rollout file", async () => {
    const selection = { provider: "codex" as const, model: "gpt-6-luna", effort: "low", cwd: realpathSync(tmpdir()), access: "none" as const };
    const saved = await funnel.run({ selection, prompt: "Reply with the single word OK." });
    const unsaved = await funnel.run({ selection, prompt: "Reply with the single word OK.", persist: false });
    const sessions = join(homedir(), ".codex", "sessions");
    expect(find(sessions, saved.sessionId!)).not.toEqual([]);
    expect(find(sessions, unsaved.sessionId!)).toEqual([]);
  }, 180_000);

  it("Cursor Agent refuses persist: false, and a workspaceName keeps its chat out of the shared folder", async () => {
    const selection = { provider: "agent" as const, model: "cursor-grok-4.5", effort: "low", cwd: realpathSync(tmpdir()), access: "none" as const };
    await expect(funnel.run({ selection, prompt: "x", persist: false })).rejects.toMatchObject({ code: "unsupported" });
    const root = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "cli-funnel", "workspaces");
    const chats = (workspace: string) => {
      const dir = join(homedir(), ".cursor", "chats", createHash("md5").update(join(root, workspace)).digest("hex"));
      return existsSync(dir) ? readdirSync(dir) : [];
    };
    const before = chats("agent-none").length;
    const r = await funnel.run({ selection, prompt: "Reply with the single word OK.", workspaceName: "cf-live-test" });
    expect(chats("agent-none-cf-live-test")).toContain(r.sessionId);
    expect(chats("agent-none")).toHaveLength(before);
  }, 180_000);
});
