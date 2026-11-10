import { describe, expect, it } from "vitest";
import { redact, redactErrors, redactSecrets } from "../src/util/redact.js";
import type { FunnelEvent } from "../src/types.js";

const GH = "ghp_" + "a1B2c3D4e5".repeat(4);
const SLACK = "xoxb-" + "1234567890-".repeat(3) + "abcdef";

async function* events(...list: FunnelEvent[]) {
  yield* list;
}
const drain = async (it: AsyncIterable<FunnelEvent>) => {
  const out: FunnelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

describe("redact", () => {
  it("cuts the query from a request line that has no host", () => {
    expect(redact("GET /v1/chat?api_key=abc failed")).toBe("GET /v1/chat failed");
  });

  it("stays fast on a megabyte with a slash every 64 characters", () => {
    const text = ("a".repeat(63) + "/").repeat(16384);
    const start = performance.now();
    redact(text);
    expect(performance.now() - start).toBeLessThan(300);
  });

  it("masks GitHub and Slack tokens, which APIs echo in error bodies", () => {
    expect(redact(`bad ${GH} and ${SLACK} here`)).toBe("bad [redacted] and [redacted] here");
  });

  it("ignores secrets shorter than 4 characters", () => {
    expect(redact("a abc b", ["abc"])).toBe("a abc b");
    expect(redact("a abcd b", ["abcd"])).toBe("a [redacted] b");
  });
});

describe("redactErrors", () => {
  it("masks gh and xox tokens in error and limit events", async () => {
    const out = await drain(
      redactErrors(
        events({ type: "error", message: `denied for ${GH}`, code: "cli-failed" }, { type: "limit", kind: "rate", detail: `slow down ${SLACK}` }),
        [],
      ),
    );
    expect(out).toEqual([
      { type: "error", message: "denied for [redacted]", code: "cli-failed" },
      { type: "limit", kind: "rate", detail: "slow down [redacted]" },
    ]);
  });
});

describe("redactErrors with access.reduced", () => {
  it("masks tokens in the reason and leaves an event without one as it is", async () => {
    const base = { type: "access.reduced", access: "full", expected: "danger-full-access", started: "read-only" } as const;
    const out = await drain(redactErrors(events({ ...base, reason: `set by ${GH}` }, base), []));
    expect(out).toEqual([{ ...base, reason: "set by [redacted]" }, base]);
  });
});

describe("redactErrors with warning", () => {
  it("masks tokens in the message", async () => {
    const out = await drain(redactErrors(events({ type: "warning", message: `bad value ${GH}` }), []));
    expect(out).toEqual([{ type: "warning", message: "bad value [redacted]" }]);
  });
});

describe("redactErrors with a thrown error", () => {
  it("masks the key in the message, stack and cause of an exception from the stream", async () => {
    const KEY = "sk-live-0123456789abcdef";
    async function* broken(): AsyncGenerator<FunnelEvent> {
      yield { type: "text.delta", text: "hi" };
      throw Object.assign(new SyntaxError(`Unexpected token in "${KEY}" at https://gw.test/v1?key=${KEY}`), { cause: new Error(`inner ${KEY}`), body: KEY });
    }
    const seen: FunnelEvent[] = [];
    let caught: any;
    try {
      for await (const e of redactErrors(broken(), [KEY])) seen.push(e);
    } catch (err) {
      caught = err;
    }
    expect(seen).toEqual([{ type: "text.delta", text: "hi" }]);
    expect(caught).toBeInstanceOf(SyntaxError);
    for (const text of [caught.message, caught.stack, caught.cause.message, caught.body]) expect(text).not.toContain(KEY);
    expect(caught.message).toContain("[redacted]");
    expect(caught.message).not.toContain("?key=");
  });
});

describe("redactSecrets across text.delta events", () => {
  const SECRET = "tok-abcdef123456";
  const texts = async (chunks: string[], extra: FunnelEvent[] = []) => {
    const out = await drain(redactSecrets(events(...chunks.map((text) => ({ type: "text.delta" as const, text })), ...extra), [SECRET]));
    return out;
  };
  const joined = (out: FunnelEvent[]) => out.map((e) => (e.type === "text.delta" ? e.text : `<${e.type}>`)).join("");

  it("masks a secret split across two chunks", async () => {
    const out = await texts(["the key is tok-abc", "def123456 ok"]);
    expect(joined(out)).toBe("the key is [redacted] ok");
  });

  it("masks a secret split over many tiny chunks", async () => {
    const out = await texts([..."a tok-abcdef123456 b"]);
    expect(joined(out)).toBe("a [redacted] b");
  });

  it("releases ordinary text at once", async () => {
    const out = await drain(redactSecrets(events({ type: "text.delta", text: "hello world" }), [SECRET]));
    expect(out).toEqual([{ type: "text.delta", text: "hello world" }]);
    const first = redactSecrets(events({ type: "text.delta", text: "hello " }, { type: "text.delta", text: "world" }), [SECRET])[Symbol.asyncIterator]();
    expect(await first.next()).toEqual({ done: false, value: { type: "text.delta", text: "hello " } });
  });

  it("flushes a held tail before another event and at the end", async () => {
    const out = await texts(["almost tok-abc"], [{ type: "done", text: "", finishReason: "stop" }]);
    expect(joined(out)).toBe("almost tok-abc<done>");
    const end = await texts(["almost tok-abc"]);
    expect(joined(end)).toBe("almost tok-abc");
  });

  it("flushes a held tail before a thrown error", async () => {
    async function* broken(): AsyncGenerator<FunnelEvent> {
      yield { type: "text.delta", text: "tok-abcdef" };
      throw new Error("boom tok-abcdef123456");
    }
    const seen: string[] = [];
    let caught: any;
    try {
      for await (const e of redactSecrets(broken(), [SECRET])) seen.push(e.type === "text.delta" ? e.text : e.type);
    } catch (err) {
      caught = err;
    }
    expect(seen.join("")).toBe("tok-abcdef");
    expect(caught.message).toBe("boom [redacted]");
  });
});
