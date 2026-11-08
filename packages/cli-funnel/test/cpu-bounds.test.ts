import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiProviders } from "../src/providers/api.js";
import { memoryHistory } from "../src/providers/history.js";
import { parseDuration, parseHttpLimit } from "../src/providers/limits.js";
import { parseJsonAnswer } from "../src/providers/prompt.js";
import { chatToolCalls } from "../src/providers/wire.js";
import { cmdQuote } from "../src/util/process.js";
import { readNDJSON } from "../src/util/ndjson.js";
import { MAX_FRAME_CHARS } from "../src/util/frames.js";
import { readSSE } from "../src/util/sse.js";
import type { FunnelEvent } from "../src/types.js";

// Each input below made the old code spend seconds. The bound is far above what linear code needs on a slow CI runner.
const BOUND_MS = 200;

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

async function timedAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

afterEach(() => vi.unstubAllGlobals());

describe("parseJsonAnswer", () => {
  // The regex this function used before the fix. Kept to prove the new code reads the same inputs the same way.
  const old = (text: string): unknown => {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
    return JSON.parse(fenced ? fenced[1]! : trimmed);
  };
  const same = (text: string) => {
    let a: unknown, b: unknown;
    try {
      a = { ok: old(text) };
    } catch {
      a = "throws";
    }
    try {
      b = { ok: parseJsonAnswer(text) };
    } catch {
      b = "throws";
    }
    expect(b, JSON.stringify(text)).toEqual(a);
  };

  it("reads fenced and bare JSON as before", () => {
    for (const text of [
      '{"a":1}',
      '```json\n{"a":1}\n```',
      '```json\n{"a":1}```',
      '```\n{"a":1}\n```',
      '```JSON\n{"a":1}\n```',
      '  ```json\n\n  {"a":1}\n\n```  ',
      '```json \n{"a":1}\n```',
      '```json {"a":1}\n```',
      '```json{"a":1}```',
      '```jsonx\n{"a":1}\n```',
      '```json\n{"a":1}',
      '{"a":1}\n```',
      "```\n```",
      "```\n\n```",
      "``````",
      "```",
      "````",
      '```json\r\n{"a":1}\r\n```',
      '```json\n"```"\n```',
      '```json\n[1,\n2]\n\n```',
    ]) same(text);
  });

  it("finishes fast on an unterminated fence followed by many newlines", () => {
    const { ms } = timed(() => {
      try {
        parseJsonAnswer("```json" + "\n".repeat(100_000) + "x");
      } catch {
        /* the text is not JSON, so it throws */
      }
    });
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe("tool call indexes", () => {
  it("does not walk a huge sparse Chat Completions index", () => {
    const c = chatToolCalls(() => "gen");
    c.add([{ index: 300_000_000, id: "a", function: { name: "f", arguments: '{"x":1}' } }]);
    const { result, ms } = timed(() => c.finish());
    expect(result).toEqual([{ id: "a", name: "f", input: { x: 1 } }]);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("returns calls in index order and ignores indexes that are not non-negative safe integers", () => {
    const c = chatToolCalls(() => "gen");
    c.add([
      { index: 2, id: "c", function: { name: "third", arguments: "{}" } },
      { index: 0, id: "a", function: { name: "first", arguments: "{}" } },
      { index: -1, id: "neg", function: { name: "bad", arguments: "{}" } },
      { index: 1.5, id: "frac", function: { name: "bad", arguments: "{}" } },
      { index: Number.MAX_SAFE_INTEGER + 2, id: "big", function: { name: "bad", arguments: "{}" } },
      { index: Number.NaN, id: "nan", function: { name: "bad", arguments: "{}" } },
    ]);
    c.add([{ index: 2, function: { arguments: "" } }]);
    expect(c.finish().map((x) => x.name)).toEqual(["first", "third"]);
  });

  it("places a delta without an index after the calls already seen", () => {
    const c = chatToolCalls(() => "gen");
    c.add([{ index: 0, id: "a", function: { name: "one", arguments: "{}" } }]);
    c.add([{ id: "b", function: { name: "two", arguments: "{}" } }]);
    expect(c.finish().map((x) => x.name)).toEqual(["one", "two"]);
  });

  const stubStream = (...bodies: string[]) => {
    const sent: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(bodies[Math.min(sent.length - 1, bodies.length - 1)], { status: 200 });
      }),
    );
    return sent;
  };
  const sse = (...events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const toolUse = (index: number, id: string) => [
    { type: "content_block_start", index, content_block: { type: "tool_use", id, name: "f", input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"k":1}' } },
    { type: "content_block_stop", index },
  ];
  const run = async (history: ReturnType<typeof memoryHistory>, prompt = "go") => {
    const provider = createApiProviders({ anthropic: "k" })["anthropic-api"];
    const events: FunnelEvent[] = [];
    for await (const e of provider.run({
      selection: { provider: "anthropic-api", model: "m-1", cwd: "/tmp", access: "full" },
      prompt,
      tools: [{ name: "f" }],
      history,
      sessionId: "s",
    }))
      events.push(e);
    return events;
  };
  it("keeps Anthropic content blocks in index order and does not walk a huge sparse index", async () => {
    const history = memoryHistory();
    const start = { type: "message_start", message: { usage: { input_tokens: 1 } } };
    const text = [
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 1 },
    ];
    const end = [{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
    const sent = stubStream(sse(start, ...toolUse(300_000_000, "late"), ...text, ...end), sse(start, ...end));
    const { result: events, ms } = await timedAsync(() => run(history));
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(1);
    expect(ms).toBeLessThan(BOUND_MS);
    await run(history, "again");
    const assistant = sent[1].messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistant.content.map((b: { type: string }) => b.type)).toEqual(["text", "tool_use"]);
  });

  it("ignores Anthropic blocks whose index is not a non-negative safe integer", async () => {
    const history = memoryHistory();
    const start = { type: "message_start", message: { usage: { input_tokens: 1 } } };
    const end = [{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, { type: "message_stop" }];
    stubStream(sse(start, ...toolUse(-1, "neg"), ...toolUse(1.5, "frac"), ...toolUse(2 ** 60, "big"), ...toolUse(0, "ok"), ...end));
    const events = await run(history);
    expect(events.filter((e): e is Extract<FunnelEvent, { type: "tool_call" }> => e.type === "tool_call").map((e) => e.id)).toEqual(["ok"]);
  });
});

describe("cmdQuote", () => {
  // The regex version this function used before the fix.
  const old = (arg: string): string => {
    let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
    out = `"${out}"`;
    return out.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
  };

  it("matches the regex version on tricky inputs", () => {
    const inputs = [
      "",
      "plain",
      "\\",
      "\\\\",
      '"',
      '""',
      '\\"',
      '\\\\"',
      '\\\\\\"',
      'a\\"b',
      'a\\\\"b\\',
      'say "hi" & exit',
      "C:\\dir\\",
      "C:\\dir\\\\",
      "C:\\dir with space\\sub\\",
      '\\\\server\\share\\"x"\\\\',
      "100%",
      "%PATH%",
      "^caret^",
      "a&b|c<d>e",
      "(group)",
      "!bang!",
      "back`tick",
      "semi;colon,comma",
      "wild*card?",
      "tab\there",
      "\\ \\",
      '\\"\\"\\',
      "\\\\\\\\a\\\\\\\\",
    ];
    for (const input of inputs) expect(cmdQuote(input), JSON.stringify(input)).toBe(old(input));
  });

  it("matches the regex version on random backslash and quote strings", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = ['\\', '\\', '"', "a", " ", "%", "^"];
    for (let n = 0; n < 500; n++) {
      let s = "";
      for (let i = Math.floor(next() * 12); i > 0; i--) s += alphabet[Math.floor(next() * alphabet.length)];
      expect(cmdQuote(s), JSON.stringify(s)).toBe(old(s));
    }
  });

  it("finishes fast on a long run of backslashes", () => {
    const { ms } = timed(() => cmdQuote("\\".repeat(60_000) + "a"));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(cmdQuote("\\".repeat(60_000) + "a")).toHaveLength(60_005);
  });
});

describe("parseDuration", () => {
  it("still reads valid durations", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1.5s")).toBe(1500);
    expect(parseDuration("6m0s")).toBe(360_000);
    expect(parseDuration("200ms")).toBe(200);
    expect(parseDuration("1h2m3s")).toBe(3_723_000);
    expect(parseDuration("30")).toBeUndefined();
    expect(parseDuration("")).toBeUndefined();
  });

  it("rejects a long malformed string quickly", () => {
    const { result, ms } = timed(() => parseDuration("1".repeat(30_000)));
    expect(result).toBeUndefined();
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("rejects a long malformed retryDelay in a Gemini error", () => {
    const body = JSON.stringify({ error: { message: "quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1".repeat(30_000) }] } });
    const { result, ms } = timed(() => parseHttpLimit(429, new Headers(), body, 0));
    expect(result?.retryAfterMs).toBeUndefined();
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("rejects a long malformed x-ratelimit-reset header quickly", () => {
    const headers = new Headers({ "x-ratelimit-reset-requests": "1".repeat(30_000), "x-ratelimit-remaining-requests": "0" });
    const { result, ms } = timed(() => parseHttpLimit(429, headers, "slow down", 0));
    expect(result?.resetAt).toBeUndefined();
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

/** A Response whose body arrives in pieces of `size` characters. */
function chunked(text: string, size: number): Response {
  let at = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= text.length) return controller.close();
        controller.enqueue(new TextEncoder().encode(text.slice(at, at + size)));
        at += size;
      },
    }),
  );
}

describe("readSSE", () => {
  it("reads events whose delimiter is split across chunks", async () => {
    const text = "event: a\r\ndata: 1\r\n\r\ndata: 2\n\ndata: 3\r\ndata: 4\n\r\n";
    for (const size of [1, 2, 3, 5, 100]) {
      const out: unknown[] = [];
      for await (const e of readSSE(chunked(text, size))) out.push(e);
      expect(out, `chunk size ${size}`).toEqual([{ event: "a", data: "1" }, { event: undefined, data: "2" }, { event: undefined, data: "3\n4" }]);
    }
  });

  it("reads one large event that arrives in many small chunks without rescanning it", async () => {
    const payload = "x".repeat(400_000);
    const { result, ms } = await timedAsync(async () => {
      const out: { data: string }[] = [];
      for await (const e of readSSE(chunked(`data: ${payload}\n\n`, 20))) out.push(e);
      return out;
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.data).toBe(payload);
    expect(ms).toBeLessThan(BOUND_MS * 5);
  });

  it("throws when an event grows past the limit without a delimiter", async () => {
    const piece = "y".repeat(1024 * 1024);
    const pieces = Math.ceil(MAX_FRAME_CHARS / piece.length) + 1;
    const body = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(piece));
          if (--left === 0) controller.close();
        },
      }),
    );
    let left = pieces;
    await expect(
      (async () => {
        for await (const _ of readSSE(body));
      })(),
    ).rejects.toThrow(/16 MiB/);
  });
});

describe("readNDJSON", () => {
  it("reads lines split across chunks, with a last line that has no newline", async () => {
    const text = '{"a":1}\n\nnot json\n{"b":2}';
    for (const size of [1, 3, 100]) {
      const out: unknown[] = [];
      for await (const e of readNDJSON(chunked(text, size))) out.push(e);
      expect(out, `chunk size ${size}`).toEqual([{ a: 1 }, { __raw: "not json" }, { b: 2 }]);
    }
  });

  it("reads one long line that arrives in many small chunks without rescanning it", async () => {
    const payload = "x".repeat(400_000);
    const { result, ms } = await timedAsync(async () => {
      const out: unknown[] = [];
      for await (const e of readNDJSON(chunked(`{"p":"${payload}"}\n`, 20))) out.push(e);
      return out;
    });
    expect(result).toHaveLength(1);
    expect(ms).toBeLessThan(BOUND_MS * 5);
  });

  it("throws when a line grows past the limit without a newline", async () => {
    const piece = "y".repeat(1024 * 1024);
    let left = Math.ceil(MAX_FRAME_CHARS / piece.length) + 1;
    const body = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(piece));
          if (--left === 0) controller.close();
        },
      }),
    );
    await expect(
      (async () => {
        for await (const _ of readNDJSON(body));
      })(),
    ).rejects.toThrow(/16 MiB/);
  });
});
