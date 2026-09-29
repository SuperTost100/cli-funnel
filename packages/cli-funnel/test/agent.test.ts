import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentProvider, buildArgs } from "../src/providers/agent/index.js";
import { groupModels, parseModelList, parseStatus, StreamMapper, toCliModel } from "../src/providers/agent/parser.js";
import { collect } from "../src/providers/base.js";
import { compareVersions, parseVersion } from "../src/util/process.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/agent/${name}`, import.meta.url), "utf8");
const lines = (name: string) =>
  fixture(name)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function replay(name: string): FunnelEvent[] {
  const mapper = new StreamMapper();
  return lines(name).flatMap((l) => mapper.map(l));
}

const listed = parseModelList(fixture("models.txt"));
const known = new Set(listed.map((m) => m.id));
const sel = (o: Partial<RunInput["selection"]> = {}): RunInput["selection"] => ({
  provider: "agent",
  model: "gpt-5.4-nano",
  cwd: "/tmp",
  access: "full",
  ...o,
});

describe("stream mapping", () => {
  it("maps a plain text run without duplicating the aggregated message", () => {
    const events = replay("text.ndjson");
    expect(events[0]).toEqual({ type: "session", sessionId: "sess-0001" });
    const deltas = events.filter((e) => e.type === "text.delta").map((e) => (e as { text: string }).text);
    expect(deltas.join("")).toBe("Hi! 👋");
    expect(events.at(-2)).toMatchObject({ type: "usage", usage: { inputTokens: 14170, outputTokens: 8, totalTokens: 14178 } });
    expect(events.at(-1)).toEqual({ type: "done", text: "Hi! 👋", finishReason: "stop" });
  });

  it("maps edit and read tool calls and reasoning", () => {
    const events = replay("edit-read.ndjson");
    expect(events.some((e) => e.type === "reasoning.delta")).toBe(true);
    const starts = events.filter((e) => e.type === "tool.start");
    expect(starts.map((e) => (e as { name: string }).name)).toEqual(["edit", "read"]);
    const ends = events.filter((e) => e.type === "tool.end");
    expect(ends).toHaveLength(2);
    expect(ends[1]).toMatchObject({ output: "hello\n" });
    expect((ends[0] as { id: string }).id).toBe((starts[0] as { id: string }).id);
  });

  it("maps shell input and a failed tool call", () => {
    const events = replay("shell-error.ndjson");
    const shell = events.find((e) => e.type === "tool.start") as { name: string; input: { command: string } };
    expect(shell.name).toBe("shell");
    expect(shell.input.command).toContain("echo cfx");
    const ends = events.filter((e) => e.type === "tool.end") as { output?: string; error?: string }[];
    expect(ends[0]?.output).toBe("cfx\n");
    expect(ends[1]?.error).toBe("File not found");
  });

  it("turns an error result into an error event", () => {
    const mapper = new StreamMapper();
    const out = mapper.map({ type: "result", subtype: "error", is_error: true, result: "boom" });
    expect(out).toEqual([{ type: "error", message: "boom" }]);
  });

  it("collects into an API-shaped result", async () => {
    async function* gen() {
      yield* replay("edit-read.ndjson");
    }
    const res = await collect(gen(), { selection: sel(), prompt: "x" });
    expect(res.sessionId).toBe("sess-0001");
    expect(res.toolCalls.map((t) => t.name)).toEqual(["edit", "read"]);
    expect(res.text).toContain("hello");
  });
});

describe("models", () => {
  const models = groupModels(listed);
  const byId = (id: string) => models.find((m) => m.id === id);

  it("drops the auto alias and groups variants", () => {
    expect(listed.some((m) => m.id === "auto")).toBe(false);
    expect(models.length).toBeLessThan(listed.length / 3);
    expect(byId("gpt-5.3-codex")).toMatchObject({ fast: true, defaultEffort: "medium" });
    expect(byId("gpt-5.3-codex")?.efforts.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(byId("gpt-5.5")?.efforts.map((e) => e.id)).toContain("xhigh");
    expect(byId("claude-opus-5-thinking")).toBeDefined();
    expect(byId("claude-4.6-opus-thinking")).toBeDefined();
    expect(byId("claude-sonnet-5-5")?.fast).toBe(false);
    expect(byId("composer-2.5")).toMatchObject({ fast: true, efforts: [] });
  });

  it("builds exact --model ids that exist in the CLI list", () => {
    expect(toCliModel(sel({ model: "gpt-5.4-nano", effort: "low" }), known)).toBe("gpt-5.4-nano-low");
    expect(toCliModel(sel({ model: "gpt-5.3-codex", effort: "high", fast: true }), known)).toBe("gpt-5.3-codex-high-fast");
    expect(toCliModel(sel({ model: "gpt-5.3-codex", effort: "medium" }), known)).toBe("gpt-5.3-codex");
    expect(toCliModel(sel({ model: "gpt-5.5", effort: "xhigh" }), known)).toBe("gpt-5.5-extra-high");
    expect(toCliModel(sel({ model: "claude-opus-5-thinking", effort: "high", fast: true }), known)).toBe("claude-opus-5-thinking-high-fast");
    expect(toCliModel(sel({ model: "claude-4.6-opus-thinking", effort: "max" }), known)).toBe("claude-4.6-opus-max-thinking");
    expect(toCliModel(sel({ model: "claude-4.5-sonnet-thinking" }), known)).toBe("claude-4.5-sonnet-thinking");
    expect(toCliModel(sel({ model: "composer-2.5", fast: true }), known)).toBe("composer-2.5-fast");
    expect(toCliModel(sel({ model: "gpt-5.2", fast: true }), known)).toBe("gpt-5.2-fast");
  });

  it("rejects combinations the CLI does not list", () => {
    expect(() => toCliModel(sel({ model: "claude-sonnet-5-5", effort: "high", fast: true }), known)).toThrow(/no variant/);
  });

  it("every grouped model resolves to a listed id", () => {
    for (const m of models) expect(known.has(toCliModel({ model: m.id, effort: m.defaultEffort }, known))).toBe(true);
  });
});

describe("run arguments and access", () => {
  const input = (o: Partial<RunInput["selection"]>, sessionId?: string): RunInput => ({ selection: sel(o), prompt: "-hi", sessionId });

  it("maps access to flags", () => {
    expect(buildArgs(input({ access: "full" }), "m")).toContain("--force");
    expect(buildArgs(input({ access: "auto" }), "m")).toContain("--auto-review");
    expect(() => buildArgs(input({ access: "supervised" }), "m")).toThrow(/cannot enforce/);
    expect(() => buildArgs(input({ access: "accept-edits" }), "m")).toThrow(/cannot enforce/);
  });

  it("passes resume, workspace and the prompt after --", () => {
    const args = buildArgs(input({ cwd: "/tmp/x" }, "chat-1"), "m1");
    expect(args).toEqual(expect.arrayContaining(["--resume", "chat-1", "--workspace", "/tmp/x", "--model", "m1", "--trust"]));
    expect(args.slice(-2)).toEqual(["--", "-hi"]);
  });

  it("does not claim approvals", () => {
    expect(agentProvider.capabilities.approvals).toBe(false);
    expect(agentProvider.capabilities.access).toEqual(["auto", "full"]);
  });
});

describe("status and versions", () => {
  it("parses status json and plan", () => {
    expect(parseStatus(fixture("status.json"), fixture("about.json"))).toEqual({
      loggedIn: true,
      method: "Cursor",
      account: "user@example.com",
      plan: "Pro",
    });
  });

  it("parses the text fallback", () => {
    expect(parseStatus("✓ Logged in as a@b.co")).toMatchObject({ loggedIn: true, account: "a@b.co" });
    expect(parseStatus("Not logged in").loggedIn).toBe(false);
  });

  it("handles date versions", () => {
    expect(parseVersion("2026.09.26-dd393fe\n")).toBe("2026.09.26-dd393fe");
    expect(compareVersions("2026.09.26-dd393fe", "2026.09.01")).toBeGreaterThan(0);
    expect(compareVersions("2026.08.30", "2026.09.01")).toBeLessThan(0);
  });
});

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1")("live", () => {
  it("runs a tiny prompt on the cheapest model", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = mkdtempSync(join(tmpdir(), "cf-agent-live-"));
    const selection = sel({ model: "gpt-5.4-nano", effort: "low", cwd });
    const first = await collect(agentProvider.run({ selection, prompt: "say hi" }), { selection, prompt: "say hi" });
    expect(first.text.length).toBeGreaterThan(0);
    expect(first.sessionId).toBeTruthy();
    const next = { selection, prompt: "say hi again", sessionId: first.sessionId };
    const second = await collect(agentProvider.run(next), next);
    expect(second.sessionId).toBe(first.sessionId);
  }, 120_000);
});
