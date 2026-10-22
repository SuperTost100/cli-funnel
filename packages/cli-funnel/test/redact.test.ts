import { describe, expect, it } from "vitest";
import { redact, redactErrors } from "../src/util/redact.js";
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
