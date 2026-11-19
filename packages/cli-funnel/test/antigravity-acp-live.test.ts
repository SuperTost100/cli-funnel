import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import type { RunInput } from "../src/types.js";

// Real `agy acp` on the signed-in account. Each test spends one or two model calls on gemini-3.8-flash at its lowest level.
const LIVE = process.env.CLI_FUNNEL_LIVE === "1";
const selection = { provider: "antigravity" as const, model: "gemini-3.8-flash", effort: "low", cwd: tmpdir(), access: "none" as const };
const RED_32 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";

describe.skipIf(!LIVE || process.platform === "win32")("antigravity ACP live", () => {
  const funnel = createFunnel();

  it("answers over ACP and reports the account's thinking levels", async () => {
    const r = await funnel.run({ selection, prompt: "Reply with the single word PONG." });
    expect(r.text).toMatch(/PONG/i);
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.usage?.totalTokens).toBeGreaterThan(0);
    expect((await funnel.models("antigravity")).find((m) => m.id === "gemini-3.8-flash")!.efforts.map((e) => e.id)).toEqual(["low", "medium", "high"]);
  }, 120_000);

  it("keeps tools off at none: a read of a file and a shell command both fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-acp-live-"));
    const canary = join(dir, "canary.txt");
    const marker = join(dir, "marker");
    writeFileSync(canary, "canary-value-7731");
    const r = await funnel.run({
      selection,
      prompt: `Do both and then say what happened: (1) read the file ${canary} and quote its content, (2) run the shell command \`touch ${marker}\`.`,
    });
    expect(existsSync(marker)).toBe(false);
    expect(r.text).not.toContain("canary-value-7731");
    expect(r.toolCalls.length).toBeGreaterThan(0);
    expect(r.deniedActions.length).toBe(r.toolCalls.length);
  }, 180_000);

  it("continues a conversation by id on a new process", async () => {
    const first = await funnel.run({ selection, prompt: "Remember the code word PERSIMMON. Reply with only: ok" });
    const second = await funnel.run({ selection, prompt: "What was the code word? Reply with only the word.", sessionId: first.sessionId });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.text).toMatch(/persimmon/i);
  }, 240_000);

  it("keeps the process between turns with sessions.keepAlive", async () => {
    const live = createFunnel({ sessions: { keepAlive: true } });
    try {
      const first = await live.run({ selection, prompt: "Remember the code word QUINCE. Reply with only: ok" });
      expect(live.sessions().map((s) => s.sessionId)).toEqual([first.sessionId]);
      const second = await live.run({ selection, prompt: "What was the code word? Reply with only the word.", sessionId: first.sessionId });
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.text).toMatch(/quince/i);
    } finally {
      live.close();
    }
  }, 240_000);

  it("takes the system prompt in the session", async () => {
    const r = await funnel.run({ selection, system: "Always end every reply with the word BANANA.", prompt: "What is 2+2? Answer in one short sentence." });
    expect(r.text).toMatch(/BANANA/);
  }, 120_000);

  it("returns JSON that matches a schema asked for in the prompt", async () => {
    const run: RunInput = {
      selection,
      prompt: "Give the capital of Italy and its country.",
      responseSchema: { schema: { type: "object", properties: { city: { type: "string" }, country: { type: "string" } }, required: ["city", "country"], additionalProperties: false } },
    };
    const r = await funnel.run(run);
    expect(r.structuredError).toBeUndefined();
    expect(r.structured).toMatchObject({ city: "Rome", country: "Italy" });
  }, 120_000);

  it("reads an image attachment", async () => {
    const r = await funnel.run({ selection, prompt: "What color is this image? One word.", attachments: [{ type: "image", mediaType: "image/png", data: RED_32 }] });
    expect(r.text).toMatch(/red/i);
  }, 120_000);
});
