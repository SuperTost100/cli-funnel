import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { antigravityProvider } from "../src/providers/antigravity/index.js";
import { parseRateLimits } from "../src/providers/antigravity/parser.js";
import { fakeShCli, sh } from "./fake-cli.js";

// The machine running the tests may have a real agy on PATH, so "not installed" is simulated.
vi.mock("../src/providers/base.js", async (importOriginal) => {
  const base = await importOriginal<typeof import("../src/providers/base.js")>();
  return { ...base, findBinary: (name: string) => (process.env.CF_TEST_NO_AGY ? undefined : base.findBinary(name)) };
});

const fixture = join(__dirname, "fixtures", "antigravity", "usage.ndjson");
const lines = readFileSync(fixture, "utf8").split("\n").filter(Boolean);
const usage = JSON.parse(lines[0]!).command.data;

const bucket = (window: "5h" | "weekly", remaining_fraction: number, reset_time?: string) => ({ id: window, name: window, window, remaining_fraction, ...(reset_time ? { reset_time } : {}) });
const group = (name: string, ...buckets: ReturnType<typeof bucket>[]) => ({ name, buckets });

describe("antigravity parseRateLimits", () => {
  it("maps the recorded /usage output", () => {
    expect(parseRateLimits(usage)).toEqual({
      provider: "antigravity",
      primary: { usedPercent: 0.9, windowMinutes: 300, resetsAt: "2026-11-10T00:00:18.000Z" },
      secondary: { usedPercent: 4.1, windowMinutes: 10080, resetsAt: "2026-11-14T09:00:11.000Z" },
      groups: [
        {
          name: "Gemini Models",
          primary: { usedPercent: 0.9, windowMinutes: 300, resetsAt: "2026-11-10T00:00:18.000Z" },
          secondary: { usedPercent: 4.1, windowMinutes: 10080, resetsAt: "2026-11-14T09:00:11.000Z" },
        },
        {
          name: "Claude and GPT models",
          primary: { usedPercent: 0, windowMinutes: 300, resetsAt: "2026-11-10T03:49:53.000Z" },
          secondary: { usedPercent: 0, windowMinutes: 10080, resetsAt: "2026-11-16T17:21:56.000Z" },
        },
        { name: "Gemini 4 Argon", secondary: { usedPercent: 0.6, windowMinutes: 10080, resetsAt: "2026-11-16T22:32:35.000Z" } },
      ],
    });
  });

  it("takes the fullest window of each kind across the groups for the top level", () => {
    const r = parseRateLimits({ groups: [group("a", bucket("5h", 0.9), bucket("weekly", 0.2)), group("b", bucket("5h", 0.5), bucket("weekly", 0.7))] });
    expect(r.primary?.usedPercent).toBe(50);
    expect(r.secondary?.usedPercent).toBe(80);
    expect(r.limit).toBeUndefined();
  });

  it("keeps a group with one window, and leaves a window out when its fraction is missing", () => {
    const r = parseRateLimits({ groups: [group("only weekly", bucket("weekly", 0.25)), { name: "broken", buckets: [{ window: "5h" }, { window: "monthly", remaining_fraction: 0 }] }] });
    expect(r.groups).toEqual([{ name: "only weekly", secondary: { usedPercent: 75, windowMinutes: 10080 } }, { name: "broken" }]);
    expect(r.primary).toBeUndefined();
  });

  it("sets no limit while one group still has room", () => {
    const r = parseRateLimits({ groups: [group("a", bucket("5h", 0, "2026-11-10T00:00:00Z")), group("b", bucket("5h", 0.4))] });
    expect(r.limit).toBeUndefined();
  });

  it("sets a rate limit when every group has a full 5-hour window, reset by the first group back", () => {
    const r = parseRateLimits({
      groups: [group("a", bucket("5h", 0, "2026-11-10T03:00:00Z"), bucket("weekly", 0.5)), group("b", bucket("5h", 0, "2026-11-10T01:00:00Z"), bucket("weekly", 0.5))],
    });
    expect(r.limit).toMatchObject({ kind: "rate", resetAt: "2026-11-10T01:00:00.000Z" });
    expect(r.limit?.detail).toContain("b");
  });

  it("sets a quota limit when the window that holds a group back is the weekly one", () => {
    const r = parseRateLimits({
      groups: [
        group("a", bucket("5h", 0, "2026-11-10T01:00:00Z"), bucket("weekly", 0, "2026-11-14T00:00:00Z")),
        group("b", bucket("weekly", 0, "2026-11-12T00:00:00Z")),
      ],
    });
    expect(r.limit).toMatchObject({ kind: "quota", resetAt: "2026-11-12T00:00:00.000Z" });
  });

  it("clamps a fraction outside 0 to 1 and rounds to one decimal", () => {
    const r = parseRateLimits({ groups: [group("a", bucket("5h", -0.2), bucket("weekly", 0.66666))] });
    expect(r.groups?.[0]).toMatchObject({ primary: { usedPercent: 100 }, secondary: { usedPercent: 33.3 } });
  });

  it("returns only the provider when there are no groups", () => {
    expect(parseRateLimits({ groups: [] })).toEqual({ provider: "antigravity" });
    expect(parseRateLimits({})).toEqual({ provider: "antigravity" });
  });
});

describe("antigravity rateLimits", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGY_BIN;
    delete process.env.CF_TEST_NO_AGY;
  });

  /** A fake agy that logs its arguments and working folder, then runs `body`. */
  function fakeAgy(body: string) {
    const dir = mkdtempSync(join(tmpdir(), "cf-agy-"));
    const log = join(dir, "log");
    process.env.CLI_FUNNEL_AGY_BIN = fakeShCli(join(dir, "agy"), `for a in "$@"; do echo "arg:$a" >> "${sh(log)}"; done\necho "cwd:$PWD" >> "${sh(log)}"\necho "env:$AGY_TEST" >> "${sh(log)}"\n${body}`);
    return () => readFileSync(log, "utf8").trim().split("\n");
  }
  const replay = `cat "${sh(fixture)}"`;

  it("asks for /usage in a neutral folder and maps the answer", async () => {
    const log = fakeAgy(replay);
    const r = await antigravityProvider.rateLimits!({ env: { AGY_TEST: "yes" } });
    expect(r).toEqual(parseRateLimits(usage));
    const seen = log();
    expect(seen).toContain("arg:--print=/usage");
    expect(seen).toContain("arg:stream-json");
    expect(seen).toContain("env:yes");
    expect(seen.find((l) => l.startsWith("cwd:"))).toContain("antigravity-none");
  });

  it("is reachable through funnel.rateLimits", async () => {
    fakeAgy(replay);
    expect((await createFunnel().rateLimits("antigravity")).groups).toHaveLength(3);
  });

  it("throws not-installed when agy is missing", async () => {
    process.env.CF_TEST_NO_AGY = "1";
    await expect(antigravityProvider.rateLimits!()).rejects.toMatchObject({ code: "not-installed" });
  });

  it("throws unsupported when the output has no usage command_result", async () => {
    fakeAgy(`echo '{"event":"result","result":{"status":"SUCCESS","response":"Unknown command: /usage","num_turns":0}}'`);
    await expect(antigravityProvider.rateLimits!()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("throws unsupported when the result reports an error", async () => {
    fakeAgy(`echo '{"event":"result","result":{"status":"ERROR","error":"usage is not available"}}'`);
    await expect(antigravityProvider.rateLimits!()).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("usage is not available") });
  });

  it("throws not-logged-in when agy asks for a sign-in", async () => {
    fakeAgy(`echo "Error: Please sign in to continue" >&2; exit 1`);
    await expect(antigravityProvider.rateLimits!()).rejects.toMatchObject({ code: "not-logged-in" });
  });

  it("throws cli-failed when agy fails for another reason", async () => {
    fakeAgy(`echo "boom" >&2; exit 2`);
    await expect(antigravityProvider.rateLimits!()).rejects.toMatchObject({ code: "cli-failed", message: expect.stringContaining("boom") });
  });

  it("throws aborted when the signal is aborted", async () => {
    fakeAgy("sleep 30");
    const ctl = new AbortController();
    const call = antigravityProvider.rateLimits!({ signal: ctl.signal });
    setTimeout(() => ctl.abort(), 200);
    await expect(call).rejects.toMatchObject({ code: "aborted" });
  });
});
