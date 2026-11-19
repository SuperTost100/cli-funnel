import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import type { Selection } from "../src/types.js";

// One conversation continued by `sessionId` on a new process, on each of the four tools, at access none. Two model calls
// each, on the cheapest model of the tool.
const LIVE = process.env.CLI_FUNNEL_LIVE === "1" && process.platform !== "win32";
const cwd = tmpdir();
const tools: [string, Selection][] = [
  ["claude", { provider: "claude", model: "claude-haiku-5-5", effort: "low", cwd, access: "none" }],
  ["codex", { provider: "codex", model: "gpt-6-luna", effort: "low", cwd, access: "none" }],
  ["agent", { provider: "agent", model: "cursor-grok-4.5", effort: "low", cwd, access: "none" }],
  ["antigravity", { provider: "antigravity", model: "gemini-3.8-flash", effort: "low", cwd, access: "none" }],
];

describe.skipIf(!LIVE)("a conversation continues by sessionId", () => {
  const funnel = createFunnel();
  it.each(tools)("%s", async (_name, selection) => {
    const first = await funnel.run({ selection, prompt: "Remember the code word PERSIMMON. Reply with only: ok" });
    expect(first.sessionId).toBeTruthy();
    const second = await funnel.run({ selection, prompt: "What was the code word? Reply with only the word.", sessionId: first.sessionId });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.text).toMatch(/persimmon/i);
  }, 240_000);
});
