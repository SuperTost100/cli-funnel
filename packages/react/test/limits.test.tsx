import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FunnelEvent, Selection } from "cli-funnel/client";
import { FunnelTranscript } from "../src/FunnelTranscript.js";
import { applyEvent, describeLimit, endTurn, startTurn, type Turn } from "../src/transcript.js";

const selection: Selection = { provider: "claude", model: "claude-haiku-4-5-20251001", cwd: "/tmp/work", access: "supervised" };
const fold = (events: FunnelEvent[], now?: number) => events.reduce((t, e) => applyEvent(t, e, now), startTurn(1, "list files", selection));
const render = (turn: Turn) => renderToStaticMarkup(<FunnelTranscript turns={[turn]} />);

const rate: FunnelEvent = { type: "limit", kind: "rate", retryAfterMs: 30_000, detail: "Too many requests." };

describe("queue position on a turn", () => {
  it("tracks the position and clears it on the first event after", () => {
    const waiting = fold([{ type: "queue.position", ahead: 2 }]);
    expect(waiting.queued).toBe(2);
    expect(applyEvent(waiting, { type: "queue.position", ahead: 1 }).queued).toBe(1);
    expect(applyEvent(waiting, { type: "session", sessionId: "s1" }).queued).toBeUndefined();
  });

  it("clears the position when the turn ends", () => {
    expect(endTurn(fold([{ type: "queue.position", ahead: 1 }]), { aborted: true }).queued).toBeUndefined();
  });

  it("shows the queue line in the transcript and drops it once the run starts", () => {
    expect(render(fold([{ type: "queue.position", ahead: 2 }]))).toContain("Waiting for a free slot. 2 runs ahead.");
    expect(render(fold([{ type: "queue.position", ahead: 1 }]))).toContain("Waiting for a free slot. 1 run ahead.");
    expect(render(fold([{ type: "queue.position", ahead: 0 }]))).toContain("You are next.");
    expect(render(fold([{ type: "queue.position", ahead: 2 }, { type: "session", sessionId: "s1" }]))).toContain("Waiting for the first token");
  });
});

describe("limit on a turn", () => {
  it("keeps the first limit and when it arrived", () => {
    const turn = fold([rate, { type: "limit", kind: "quota", detail: "later" }], 1000);
    expect(turn.limit).toEqual({ kind: "rate", retryAfterMs: 30_000, detail: "Too many requests." });
    expect(turn.limitAt).toBe(1000);
  });

  it("shows the limit as a polite live note with its detail and time", () => {
    const html = render(endTurn(fold([rate, { type: "error", message: "rate limited" }], 0)));
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Rate limit.");
    expect(html).toContain("Too many requests.");
    expect(html).toContain("Retry in 30 s.");
  });

  it("shows nothing extra without a limit", () => {
    expect(render(fold([{ type: "text.delta", text: "hi" }]))).not.toContain("cf-limit");
  });
});

describe("describeLimit", () => {
  const utc = { locale: "en-US", timeZone: "UTC" };
  const noon = Date.UTC(2026, 9, 16, 12, 0, 0);

  it("anchors retryAfterMs at the arrival and counts down from now", () => {
    const note = describeLimit({ kind: "rate", retryAfterMs: 5 * 60_000, detail: "Slow down." }, noon, noon + 60_000, utc);
    expect(note).toEqual({ title: "Rate limit", detail: "Slow down.", when: "Retry in 4 min, at 12:05 PM." });
  });

  it("prefers resetAt and adds the weekday and date when it is not today", () => {
    const note = describeLimit({ kind: "quota", resetAt: "2026-10-19T09:30:00Z", retryAfterMs: 1000, detail: "Weekly limit." }, noon, noon, utc);
    expect(note.title).toBe("Quota reached");
    expect(note.when).toBe("Resets in 3 days, at Mon, Oct 19, 9:30 AM.");
  });

  it("formats the time in the given time zone", () => {
    const note = describeLimit({ kind: "quota", resetAt: "2026-10-16T18:00:00Z", detail: "d" }, noon, noon, { locale: "en-US", timeZone: "Asia/Tokyo" });
    expect(note.when).toBe("Resets in 6 h, at Sat, Oct 17, 3:00 AM.");
  });

  it("says nothing about time when the provider gave none, and handles a time that has passed", () => {
    expect(describeLimit({ kind: "rate", detail: "d" }, noon, noon, utc).when).toBeUndefined();
    expect(describeLimit({ kind: "rate", retryAfterMs: 1000, detail: "d" }, noon, noon + 5000, utc).when).toBe("You can retry now.");
    expect(describeLimit({ kind: "quota", resetAt: "2026-10-16T11:00:00Z", detail: "d" }, noon, noon, utc).when).toBe("Should have reset by now.");
    expect(describeLimit({ kind: "quota", resetAt: "garbage", detail: "d" }, noon, noon, utc).when).toBeUndefined();
  });

  it("drops the clock for waits under a minute and a half", () => {
    expect(describeLimit({ kind: "rate", retryAfterMs: 45_000, detail: "d" }, noon, noon, utc).when).toBe("Retry in 45 s.");
  });
});
