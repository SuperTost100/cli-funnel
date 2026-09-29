import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collect } from "../src/providers/base.js";
import { antigravityProvider, buildArgs } from "../src/providers/antigravity/index.js";
import { createMapper, parseModels } from "../src/providers/antigravity/parser.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

const fx = (n: string) => readFileSync(new URL(`./fixtures/antigravity/${n}`, import.meta.url), "utf8");
const events = (n: string): FunnelEvent[] => {
  const m = createMapper();
  return fx(n).split("\n").filter(Boolean).flatMap((l) => m.map(JSON.parse(l)));
};
const input = (over: Partial<RunInput["selection"]> = {}): RunInput => ({
  prompt: "hi",
  selection: { provider: "antigravity", model: "gemini-3.8-flash", effort: "low", cwd: "/tmp", access: "full", ...over },
});

describe("antigravity parser", () => {
  it("groups effort variants into base models", () => {
    const models = parseModels(fx("models.txt"));
    const flash = models.find((m) => m.id === "gemini-3.8-flash")!;
    expect(flash.efforts.map((e) => e.id)).toEqual(["low", "medium", "high"]);
    expect(models.find((m) => m.id === "gemini-3.1-pro")!.efforts.map((e) => e.id)).toEqual(["low", "high"]);
    expect(models.find((m) => m.id === "claude-sonnet-4-6")!.efforts).toEqual([]);
    expect(models.find((m) => m.id === "gpt-oss-120b-medium")!.efforts).toEqual([]);
  });

  it("maps a simple run", async () => {
    const r = await collect((async function* () { yield* events("simple.ndjson"); })(), input());
    expect(r.text).toBe("OK\n");
    expect(r.sessionId).toBeTruthy();
    expect(r.usage?.totalTokens).toBe(13453);
  });

  it("maps a tool call", () => {
    const e = events("tool.ndjson");
    expect(e.some((x) => x.type === "tool.start" && x.name === "write_to_file")).toBe(true);
    expect(e.some((x) => x.type === "tool.end" && !x.error)).toBe(true);
  });

  it("reports denied tools", async () => {
    const e = events("denied.ndjson");
    const denied = e.filter((x) => x.type === "tool.end" && x.error?.startsWith("denied:"));
    expect(denied).toHaveLength(1);
    expect(e.at(-1)).toMatchObject({ type: "done", finishReason: "denied" });
  });

  it("maps CLI errors", () => {
    expect(events("error.ndjson")[0]).toMatchObject({ type: "error", code: "cli-failed" });
  });

  it("builds args", () => {
    const args = buildArgs(input({ access: "accept-edits" }));
    expect(args).toEqual(expect.arrayContaining(["--model", "gemini-3.8-flash", "--effort", "low", "--mode", "accept-edits"]));
    expect(buildArgs(input({ access: "full" }), [])).toContain("--dangerously-skip-permissions");
  });
});

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1")("antigravity live", () => {
  it("answers a tiny prompt", async () => {
    const r = await collect(
      antigravityProvider.run({ ...input({ cwd: "/tmp", model: "gemini-3.8-flash", effort: "low" }), prompt: "Reply with the word OK" }),
      input(),
    );
    expect(r.text).toMatch(/OK/);
    expect((await antigravityProvider.authStatus()).loggedIn).toBe(true);
  }, 90_000);
});
