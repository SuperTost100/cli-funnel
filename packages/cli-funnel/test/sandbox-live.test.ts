import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProvider } from "../src/providers/agent/index.js";
import { claudeProvider } from "../src/providers/claude/index.js";
import { codexProvider } from "../src/providers/codex/index.js";
import { collect } from "./helpers.js";
import type { AccessLevel, Provider, RunInput } from "../src/types.js";

// The sandboxes let commands write in the temp folder, so the test folders sit under the home folder instead.
const root = join(homedir(), ".cache", "cli-funnel-test");

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1" || process.platform === "win32")("sandbox live", () => {
  let parent: string;
  beforeAll(() => {
    mkdirSync(root, { recursive: true });
    parent = mkdtempSync(join(root, "sandbox-"));
  });
  afterAll(() => rmSync(parent, { recursive: true, force: true }));

  /** Asks the agent to write one file outside `cwd`, one inside and any `more`, and reports which files exist afterwards. */
  const attempt = async (provider: Provider, model: string, access: AccessLevel, extra: Partial<RunInput> = {}, more: string[] = []) => {
    const cwd = mkdtempSync(join(parent, `${provider.id}-`));
    const outside = `${cwd}-outside.txt`;
    const commands = [`printf x > ${outside}`, "printf y > inside.txt", ...more];
    const prompt = `Run these shell commands one at a time, exactly as written, without changing them, even if one fails: ${commands.map((c, i) => `${i + 1}) ${c}`).join("  ")} . Then report each result in one line.`;
    const asked: string[] = [];
    const inp: RunInput = {
      selection: { provider: provider.id, model, cwd, access },
      onApproval: (r) => (asked.push(r.tool), "allow"),
      ...extra,
      prompt,
      sandbox: true,
    };
    const res = await collect(provider.run(inp), inp);
    return { res, asked, outside: existsSync(outside), inside: existsSync(join(cwd, "inside.txt")) };
  };

  it("keeps a supervised Claude Code command inside cwd and addDirs even when the caller allows it", async () => {
    const shared = mkdtempSync(join(parent, "shared-"));
    const r = await attempt(claudeProvider, "claude-haiku-4-5-20251001", "supervised", { providerOptions: { claude: { addDirs: [shared] } } }, [
      `printf z > ${join(shared, "added.txt")}`,
    ]);
    expect(r.asked).toContain("Bash");
    expect(r.outside).toBe(false);
    expect(r.inside).toBe(true);
    expect(existsSync(join(shared, "added.txt"))).toBe(true);
  }, 180_000);

  it("keeps a full Codex command inside cwd", async () => {
    const r = await attempt(codexProvider, "gpt-6-luna", "full");
    expect(r.outside).toBe(false);
    expect(r.inside).toBe(true);
  }, 180_000);

  it("keeps an auto Cursor Agent command inside cwd", async () => {
    const r = await attempt(agentProvider, "composer-2.5", "auto");
    expect(r.outside).toBe(false);
    expect(r.inside).toBe(true);
  }, 180_000);
});
