import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { feedbackParams, parseFeedback, parseRateLimits, parseThread, parseThreadPage } from "../src/providers/codex/threads.js";

// Results recorded from codex 0.160.0 (`thread/list`, `account/rateLimits/read`), with ids, paths and account data replaced.
// `feedback-upload.json` follows the FeedbackUploadResponse schema of codex 0.166.0 instead: recording one would send a
// real report to OpenAI.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/codex/${name}.json`, import.meta.url), "utf8"));

describe("codex thread/list", () => {
  it("maps threads to provider-neutral info, in milliseconds", () => {
    const page = parseThreadPage(fixture("thread-list"));
    expect(page.nextCursor).toBe("2026-01-01T00:00:00Z");
    expect(page.threads).toEqual([
      { provider: "codex", sessionId: "00000000-0000-4000-8000-000000000001", title: "Reply with the single word: ready", cwd: "/tmp/work", createdAt: 1792095606_000, updatedAt: 1792095615_000 },
      {
        provider: "codex",
        sessionId: "00000000-0000-4000-8000-000000000002",
        title: "Reply with the single word: apple",
        cwd: "/tmp/work",
        createdAt: 1792095599_000,
        updatedAt: 1792095603_000,
        forkedFrom: "00000000-0000-4000-8000-000000000009",
      },
    ]);
  });

  it("prefers the user's title and ends the paging on a null cursor", () => {
    expect(parseThread({ id: "t", name: "Mine", preview: "first message", createdAt: 1, updatedAt: 2 }).title).toBe("Mine");
    expect(parseThreadPage({ data: [], nextCursor: null })).toEqual({ threads: [] });
  });
});

describe("codex account/rateLimits/read", () => {
  it("maps the usage windows and plan", () => {
    expect(parseRateLimits(fixture("rate-limits"))).toEqual({
      provider: "codex",
      plan: "plus",
      primary: { usedPercent: 7, windowMinutes: 300, resetsAt: new Date(1792150253 * 1000).toISOString() },
      secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: new Date(1792663278 * 1000).toISOString() },
    });
  });

  it("carries the limit that is reached, as a limit event would", () => {
    const full = fixture("rate-limits");
    full.rateLimits.secondary.usedPercent = 100;
    expect(parseRateLimits(full).limit).toEqual({ kind: "quota", detail: "Codex usage limit reached.", resetAt: new Date(1792663278 * 1000).toISOString() });
    full.rateLimits.secondary.usedPercent = 10;
    full.rateLimits.primary.usedPercent = 100;
    expect(parseRateLimits(full).limit).toMatchObject({ kind: "rate", resetAt: new Date(1792150253 * 1000).toISOString() });
  });

  it("copes with an answer that has no windows", () => {
    expect(parseRateLimits({ rateLimits: { planType: "free", primary: null, secondary: null } })).toEqual({ provider: "codex", plan: "free" });
  });
});

describe("codex feedback/upload", () => {
  it("builds the params Codex's /feedback sends", () => {
    expect(feedbackParams({ classification: "bad_result", sessionId: "thr-1", reason: "  Made up a function.  ", includeLogs: true })).toEqual({
      classification: "bad_result",
      reason: "Made up a function.",
      threadId: "thr-1",
      includeLogs: true,
    });
  });

  it("leaves out what the report does not set, and logs stay off", () => {
    expect(feedbackParams({ classification: "other", reason: "   " })).toEqual({ classification: "other", includeLogs: false });
  });

  it("refuses values Codex would file under the wrong kind", () => {
    expect(() => feedbackParams({ classification: "bad" as never })).toThrow(expect.objectContaining({ code: "invalid-selection" }));
    expect(() => feedbackParams({ classification: "bug", sessionId: "" })).toThrow("sessionId");
    expect(() => feedbackParams({ classification: "bug", includeLogs: "yes" as never })).toThrow("includeLogs");
    expect(() => feedbackParams({ classification: "bug", reason: 3 as never })).toThrow("reason");
  });

  it("reads the report id from the answer", () => {
    expect(parseFeedback(fixture("feedback-upload"))).toBe("00000000-0000-4000-8000-000000000001");
    expect(parseFeedback({ threadId: "no-active-thread-abc", promptHash: null })).toBe("no-active-thread-abc");
  });

  it("fails when the answer has no id", () => {
    expect(() => parseFeedback({})).toThrow(expect.objectContaining({ code: "cli-failed" }));
  });
});
