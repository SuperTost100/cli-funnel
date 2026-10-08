import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { fileHistory, memoryHistory } from "../src/providers/history.js";
import type { RunInput } from "../src/types.js";

const reply = (text: string) =>
  new Response(
    [
      { type: "message_start", message: { usage: { input_tokens: 3 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

describe("fileHistory", () => {
  it("keeps sessions across store instances, owner-readable only", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cf-history-")), "sessions");
    await fileHistory(dir).set("s1", [{ role: "user", content: "hi" }]);
    expect(await fileHistory(dir).get("s1")).toEqual([{ role: "user", content: "hi" }]);
    expect(await fileHistory(dir).get("other")).toBeUndefined();
    const [name] = readdirSync(dir);
    expect(statSync(join(dir, name!)).mode & 0o777).toBe(0o600);
  });

  it("keeps a session id from naming a path outside the folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-history-"));
    await fileHistory(join(dir, "s")).set("../../escape", [1]);
    expect(readdirSync(dir)).toEqual(["s"]);
    expect(await fileHistory(join(dir, "s")).get("../../escape")).toEqual([1]);
  });

  it("drops the least recently written sessions past the limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-history-"));
    const store = fileHistory(dir, 2);
    for (const id of ["a", "b", "c"]) {
      await store.set(id, [id]);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("c")).toEqual(["c"]);
    expect(readdirSync(dir)).toHaveLength(2);
  });
});

describe("funnel history option", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("continues an API session after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-history-"));
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return reply("Hello.");
    }));
    const input = (over: Partial<RunInput> = {}): RunInput => ({
      selection: { provider: "anthropic-api", model: "claude-haiku-4-5-20251001", cwd: "/tmp", access: "full" },
      prompt: "Hi.",
      ...over,
    });
    const make = () => createFunnel({ apiKeys: { anthropic: "k" }, history: fileHistory(dir), allowUnlistedModels: true });
    const first = await make().run(input());
    await make().run(input({ prompt: "Again.", sessionId: first.sessionId }));
    expect(bodies[1].messages).toEqual([
      { role: "user", content: "Hi." },
      { role: "assistant", content: "Hello." },
      { role: "user", content: "Again." },
    ]);
  });

  it("lets a run pick its own store", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply("ok")));
    const mine = memoryHistory();
    const funnel = createFunnel({ apiKeys: { anthropic: "k" }, history: fileHistory(mkdtempSync(join(tmpdir(), "cf-history-"))), allowUnlistedModels: true });
    const r = await funnel.run({
      selection: { provider: "anthropic-api", model: "m", cwd: "/tmp", access: "full" },
      prompt: "Hi.",
      history: mine,
    });
    expect(await mine.get(r.sessionId!)).toHaveLength(2);
  });
});
