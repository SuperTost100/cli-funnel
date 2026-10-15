import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect } from "../src/providers/base.js";
import { createApiProviders } from "../src/providers/api.js";
import { parseClaudeMessage } from "../src/providers/claude/parser.js";
import { Translator } from "../src/providers/codex/events.js";
import { parseDuration, parseHttpLimit } from "../src/providers/limits.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

// Limit payloads are written by hand. Nobody hits a real limit on purpose. The Claude shape follows the
// rate_limit_event builder in Claude Code 2.1.300, the Codex shape follows `codex app-server generate-json-schema`,
// and the HTTP shapes follow each vendor's API reference.

const NOW = Date.parse("2026-10-15T12:00:00Z");

describe("parseHttpLimit", () => {
  it("ignores anything but 429", () => {
    expect(parseHttpLimit(500, new Headers(), "boom", NOW)).toBeUndefined();
    expect(parseHttpLimit(401, new Headers({ "retry-after": "5" }), "", NOW)).toBeUndefined();
  });

  it("reads Anthropic's retry-after and the reset of the exhausted limit", () => {
    const headers = new Headers({
      "retry-after": "20",
      "anthropic-ratelimit-requests-remaining": "0",
      "anthropic-ratelimit-requests-reset": "2026-10-15T12:00:20Z",
      "anthropic-ratelimit-tokens-remaining": "5000",
      "anthropic-ratelimit-tokens-reset": "2026-10-15T12:05:00Z",
    });
    const body = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit." } });
    expect(parseHttpLimit(429, headers, body, NOW)).toEqual({
      type: "limit",
      kind: "rate",
      retryAfterMs: 20_000,
      resetAt: "2026-10-15T12:00:20.000Z",
      detail: "Number of requests has exceeded your rate limit.",
    });
  });

  it("reads OpenAI's duration headers and tells a used-up balance from a rate limit", () => {
    const headers = new Headers({ "retry-after-ms": "1500", "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "6m0s", "x-ratelimit-remaining-requests": "10", "x-ratelimit-reset-requests": "1s" });
    const rate = parseHttpLimit(429, headers, JSON.stringify({ error: { message: "Rate limit reached for gpt-x.", type: "tokens", code: "rate_limit_exceeded" } }), NOW);
    expect(rate).toMatchObject({ kind: "rate", retryAfterMs: 1500, resetAt: "2026-10-15T12:06:00.000Z" });
    const quota = parseHttpLimit(429, new Headers(), JSON.stringify({ error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } }), NOW);
    expect(quota).toEqual({ type: "limit", kind: "quota", detail: "You exceeded your current quota." });
  });

  it("reads Gemini's RetryInfo", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "You exceeded your current quota, please check your plan and billing details.",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "31s" }],
      },
    });
    expect(parseHttpLimit(429, new Headers(), body, NOW)).toMatchObject({ kind: "rate", retryAfterMs: 31_000 });
  });

  it("takes retry-after as an HTTP date and keeps a plain-text body", () => {
    const limit = parseHttpLimit(429, new Headers({ "retry-after": "Thu, 15 Oct 2026 12:01:00 GMT" }), "slow down", NOW);
    expect(limit).toEqual({ type: "limit", kind: "rate", retryAfterMs: 60_000, detail: "slow down" });
  });

  it("parses Go-style durations", () => {
    expect(parseDuration("6m0s")).toBe(360_000);
    expect(parseDuration("1.5s")).toBe(1500);
    expect(parseDuration("200ms")).toBe(200);
    expect(parseDuration("1h2m3s")).toBe(3_723_000);
    expect(parseDuration("soon")).toBeUndefined();
  });
});

describe("API providers", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Retries are off, so the first 429 is the last answer.
  it("emit a redacted limit before the error on a 429, and the thrown error carries it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Too many requests for sk-test-1234567890." } }), { status: 429, headers: { "retry-after": "3" } })));
    const input: RunInput = { selection: { provider: "anthropic-api", model: "claude-x", cwd: "/tmp", access: "full" }, prompt: "hi" };
    const events: FunnelEvent[] = [];
    for await (const e of createApiProviders({}, { anthropic: { key: "k", retries: 0 } })["anthropic-api"].run(input)) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["session", "limit", "error"]);
    const err = await collect((async function* () { yield* events; })(), input).catch((e: unknown) => e);
    expect(err).toMatchObject({ limit: { kind: "rate", retryAfterMs: 3000, detail: "Too many requests for [redacted]." } });
  });
});

describe("Claude Code limits", () => {
  const event = (info: object) => parseClaudeMessage({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" });

  it("reports a rejected window and ignores the usage report on every turn", () => {
    expect(event({ status: "allowed", resetsAt: 1_760_000_000, rateLimitType: "five_hour", utilization: 0.4 })).toEqual([]);
    expect(event({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9 })).toEqual([]);
    expect(event({ status: "rejected", resetsAt: 1_760_533_200, rateLimitType: "five_hour" })).toEqual([
      { type: "limit", kind: "rate", detail: "Claude five-hour limit reached.", resetAt: "2025-10-15T13:00:00.000Z" },
    ]);
    expect(event({ status: "rejected", rateLimitType: "seven_day_opus" })).toEqual([{ type: "limit", kind: "quota", detail: "Claude weekly Opus limit reached." }]);
  });

  it("turns a 429 result into a limit and an error", () => {
    const events = readFileSync(new URL("./fixtures/claude/error-credits.ndjson", import.meta.url), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => parseClaudeMessage(JSON.parse(l)));
    expect(events.slice(-2)).toEqual([
      { type: "limit", kind: "quota", detail: expect.stringContaining("requires usage credits") },
      expect.objectContaining({ type: "error", code: "429" }),
    ]);
  });
});

describe("Codex limits", () => {
  const window = (usedPercent: number, windowDurationMins: number) => ({ usedPercent, windowDurationMins, resetsAt: 1_760_533_200 });

  it("reports a full window once and ignores usage below it", () => {
    const t = new Translator("th");
    expect(t.handle("account/rateLimits/updated", { rateLimits: { primary: window(40, 300), secondary: window(10, 10080) } }).events).toEqual([]);
    const full = { rateLimits: { primary: window(100, 300), secondary: window(60, 10080), rateLimitReachedType: "rate_limit_reached" } };
    expect(t.handle("account/rateLimits/updated", full).events).toEqual([
      { type: "limit", kind: "rate", detail: "Codex usage limit reached.", resetAt: "2025-10-15T13:00:00.000Z" },
    ]);
    expect(t.handle("account/rateLimits/updated", full).events).toEqual([]);
  });

  it("counts the weekly window and used-up credits as a quota", () => {
    const weekly = new Translator("th").handle("account/rateLimits/updated", { rateLimits: { primary: window(70, 300), secondary: window(100, 10080) } });
    expect(weekly.events).toMatchObject([{ kind: "quota" }]);
    const credits = new Translator("th").handle("account/rateLimits/updated", { rateLimits: { rateLimitReachedType: "workspace_member_credits_depleted" } });
    expect(credits.events).toEqual([{ type: "limit", kind: "quota", detail: "Codex workspace credits are used up." }]);
  });

  it("reports limits from error kinds, also when Codex retries", () => {
    const t = new Translator("th");
    const retried = t.handle("error", { threadId: "th", willRetry: true, error: { message: "Rate limited.", codexErrorInfo: "rateLimitExceeded" } });
    expect(retried).toEqual({ events: [{ type: "limit", kind: "rate", detail: "Rate limited." }] });
    const failed = t.handle("error", { threadId: "th", willRetry: false, error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } });
    expect(failed.events.map((e) => e.type)).toEqual(["limit", "error"]);
    expect(failed.events[0]).toMatchObject({ kind: "quota" });
    const other = t.handle("error", { threadId: "th", willRetry: false, error: { message: "Bad request.", codexErrorInfo: "badRequest" } });
    expect(other.events.map((e) => e.type)).toEqual(["error"]);
  });
});

describe("RunResult.limit", () => {
  it("keeps the first limit of the run", async () => {
    const input: RunInput = { selection: { provider: "claude", model: "m", cwd: "/tmp", access: "full" }, prompt: "hi" };
    const result = await collect(
      (async function* (): AsyncGenerator<FunnelEvent> {
        yield { type: "limit", kind: "rate", detail: "first", resetAt: "2026-10-15T13:00:00.000Z" };
        yield { type: "limit", kind: "quota", detail: "second" };
        yield { type: "done", text: "ok", finishReason: "stop" };
      })(),
      input,
    );
    expect(result.limit).toEqual({ kind: "rate", detail: "first", resetAt: "2026-10-15T13:00:00.000Z" });
  });
});
