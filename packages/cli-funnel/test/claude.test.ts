import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArgs, claudeProvider } from "../src/providers/claude/index.js";
import { parseClaudeMessage } from "../src/providers/claude/parser.js";
import { collect } from "../src/providers/base.js";
import type { FunnelEvent, RunInput, Selection } from "../src/types.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => parseClaudeMessage(JSON.parse(l)));

const sel = (over: Partial<Selection> = {}): Selection => ({
  provider: "claude", model: "claude-haiku-4-5-20251001", cwd: "/tmp", access: "accept-edits", ...over,
});

describe("claude parser", () => {
  it("maps a plain text run", () => {
    const ev = fixture("text");
    expect(ev[0]).toMatchObject({ type: "session", model: "claude-haiku-4-5-20251001" });
    expect(ev.some((e) => e.type === "text.delta")).toBe(true);
    expect(ev.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
    expect(ev.find((e) => e.type === "usage")).toBeTruthy();
  });

  it("maps tool calls and results", () => {
    const ev = fixture("tool-allow");
    const start = ev.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ name: "Write", input: { content: "hi" } });
    const end = ev.find((e) => e.type === "tool.end");
    expect(end).toMatchObject({ id: (start as any).id });
    expect((end as any).error).toBeUndefined();
  });

  it("reports a denied tool", () => {
    const ev = fixture("tool-deny");
    expect(ev.find((e) => e.type === "tool.end")).toMatchObject({ error: "User denied" });
    expect(ev.at(-1)).toMatchObject({ type: "done", finishReason: "denied" });
  });

  it("turns an is_error result into an error event", () => {
    const ev = fixture("error-credits");
    expect(ev.at(-1)).toMatchObject({ type: "error", code: "429" });
  });
});

describe("claude args", () => {
  it("maps access levels and the approval channel", () => {
    const base = { prompt: "x" };
    const sup = buildArgs({ ...base, selection: sel({ access: "supervised", effort: "low" }), onApproval: () => "allow", sessionId: "abc" });
    expect(sup).toEqual(expect.arrayContaining(["--permission-mode", "manual", "--permission-prompt-tool", "stdio", "--effort", "low", "--resume", "abc"]));
    const full = buildArgs({ ...base, selection: sel({ access: "full" }), onApproval: () => "allow" });
    expect(full).toContain("bypassPermissions");
    expect(full).not.toContain("--permission-prompt-tool");
    expect(full).not.toContain("--bare");
  });
});

describe("claude models", () => {
  it("lists concrete ids from the manifest", async () => {
    const models = await claudeProvider.models();
    expect(models.map((m) => m.id)).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
    expect(models.every((m) => !m.fast)).toBe(true);
  });
});

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1")("claude live", () => {
  it("runs, asks for approval, and resumes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cf-claude-live-"));
    const asked: string[] = [];
    const input: RunInput = {
      selection: sel({ cwd, access: "supervised" }),
      prompt: "Create hello.txt containing hi with the Write tool.",
      onApproval: (r) => (asked.push(r.tool), "allow"),
    };
    const events: FunnelEvent[] = [];
    const first = await collect((async function* () { for await (const e of claudeProvider.run(input)) { events.push(e); yield e; } })(), input);
    expect(asked).toContain("Write");
    expect(first.sessionId).toBeTruthy();
    const second = await collect(claudeProvider.run({ ...input, prompt: "Say ok.", sessionId: first.sessionId, selection: sel({ cwd, access: "accept-edits" }) }), input);
    expect(second.text.length).toBeGreaterThan(0);
  }, 120_000);
});
