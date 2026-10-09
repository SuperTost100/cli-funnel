import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect } from "../src/providers/base.js";
import { createApiProviders } from "../src/providers/api.js";
import { parseClaudeMessage } from "../src/providers/claude/parser.js";
import { Translator } from "../src/providers/codex/events.js";
import { agentProvider } from "../src/providers/agent/index.js";
import { buildArgs as agyArgs, stdinPrompt } from "../src/providers/antigravity/index.js";
import { MAX_SESSIONS } from "../src/providers/history.js";
import { mapChatLine } from "../src/providers/ollama/parser.js";
import { serveNode } from "../src/server/node.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

const drain = async (events: AsyncIterable<FunnelEvent>) => {
  const out: FunnelEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};
const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const anthropicText = (text: string) =>
  [
    { type: "message_start", message: { usage: { input_tokens: 3 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ]
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("");

describe("claude result", () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`./fixtures/claude/${name}.ndjson`, import.meta.url), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => parseClaudeMessage(JSON.parse(l)));
  const input = { selection: { provider: "claude", model: "m", cwd: "/tmp", access: "accept-edits" }, prompt: "x" } as RunInput;

  it("lists permission denials in deniedActions", async () => {
    const events = fixture("tool-deny");
    const r = await collect((async function* () { yield* events; })(), input);
    expect(r.deniedActions).toEqual(["Write"]);
    expect(r.finishReason).toBe("denied");
  });
});

describe("codex declines", () => {
  it("marks declined commands and file changes as denied", () => {
    const t = new Translator("a");
    const cmd = t.handle("item/completed", { threadId: "a", item: { type: "commandExecution", id: "c1", status: "declined" } }).events[0];
    const file = t.handle("item/completed", { threadId: "a", item: { type: "fileChange", id: "f1", status: "declined" } }).events[0];
    expect(cmd).toMatchObject({ error: "denied: Command declined" });
    expect(file).toMatchObject({ error: "denied: File change declined" });
    const failed = t.handle("item/completed", { threadId: "a", item: { type: "commandExecution", id: "c2", status: "failed", exitCode: 1 } }).events[0];
    expect(failed).toMatchObject({ error: "Command failed (exit 1)" });
  });
});

describe("API sessions", () => {
  afterEach(() => vi.unstubAllGlobals());
  const provider = () => createApiProviders({ anthropic: "k" })["anthropic-api"];
  const input = (over: Partial<RunInput> = {}): RunInput => ({
    selection: { provider: "anthropic-api", model: "claude-test", cwd: "/tmp", access: "full" },
    prompt: "Hi.",
    ...over,
  });

  it("does not store a failed turn, so the next turn still works", async () => {
    const bodies: any[] = [];
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return fail ? new Response("overloaded", { status: 529 }) : sse(anthropicText("Hello."));
    }));
    const first = await collect(provider().run(input()), input());
    fail = true;
    const failed = await drain(provider().run(input({ prompt: "Again.", sessionId: first.sessionId })));
    expect(failed.at(-1)).toMatchObject({ type: "error" });
    fail = false;
    await drain(provider().run(input({ prompt: "Once more.", sessionId: first.sessionId })));
    expect(bodies[2].messages).toEqual([
      { role: "user", content: "Hi." },
      { role: "assistant", content: "Hello." },
      { role: "user", content: "Once more." },
    ]);
  });

  it("ends an aborted run as cancelled instead of throwing", async () => {
    const ac = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => {
      ac.abort();
      throw new DOMException("This operation was aborted", "AbortError");
    }));
    const events = await drain(provider().run(input({ signal: ac.signal })));
    expect(events.at(-1)).toEqual({ type: "done", text: "", finishReason: "cancelled" });
  });

  it("turns a network failure into an error event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const events = await drain(provider().run(input()));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cli-failed" });
  });

  it("drops the oldest sessions past the limit", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sse(anthropicText("ok"));
    }));
    const oldest = await collect(provider().run(input()), input());
    for (let i = 0; i < MAX_SESSIONS; i++) await drain(provider().run(input()));
    await drain(provider().run(input({ prompt: "Still there?", sessionId: oldest.sessionId })));
    expect(bodies.at(-1).messages).toEqual([{ role: "user", content: "Still there?" }]);
  });
});

describe("output limit", () => {
  afterEach(() => vi.unstubAllGlobals());
  const events = (lines: object[]) => sse(lines.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
  const run = async (provider: "anthropic-api" | "openai-api" | "gemini-api", body: Response) => {
    vi.stubGlobal("fetch", vi.fn(async () => body));
    const p = createApiProviders({ anthropic: "k", openai: "k", gemini: "k" })[provider];
    const input: RunInput = { selection: { provider, model: "m", cwd: "/tmp", access: "full" }, prompt: "x", maxOutputTokens: 1 };
    return (await drain(p.run(input))).at(-1);
  };

  it("ends a cut-off answer with finishReason length", async () => {
    const anthropic = events([{ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } }]);
    expect(await run("anthropic-api", anthropic)).toMatchObject({ finishReason: "length" });
    const openai = events([{ choices: [{ delta: { content: "a" }, finish_reason: "length" }] }]);
    expect(await run("openai-api", openai)).toMatchObject({ finishReason: "length" });
    const gemini = events([{ candidates: [{ content: { parts: [{ text: "a" }] }, finishReason: "MAX_TOKENS" }] }]);
    expect(await run("gemini-api", gemini)).toMatchObject({ finishReason: "length" });
    expect(mapChatLine({ done: true, done_reason: "length" }).at(-1)).toMatchObject({ finishReason: "length" });
    expect(mapChatLine({ done: true, done_reason: "stop" }).at(-1)).toMatchObject({ finishReason: "stop" });
  });
});

describe("agent process", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGENT_BIN;
  });

  it("stops the CLI when the caller stops reading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agent-"));
    const bin = join(dir, "agent");
    const pidFile = join(dir, "pid");
    writeFileSync(
      bin,
      `#!/bin/sh\n[ "$1" = "--list-models" ] && exit 0\necho '{"type":"system","subtype":"init","session_id":"s1"}'\necho $$ > ${pidFile}\nexec sleep 30\n`,
    );
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGENT_BIN = bin;
    for await (const e of agentProvider.run({ selection: { provider: "agent", model: "m", cwd: dir, access: "full" }, prompt: "x" })) {
      if (e.type === "session") break;
    }
    await new Promise((r) => setTimeout(r, 200));
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("long prompts", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_AGENT_BIN;
  });
  // Linux refuses a single argv string over 128 KiB with E2BIG.
  const prompt = "x".repeat(200_000);

  it("sends the agent prompt on stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agent-"));
    const bin = join(dir, "agent");
    // Reports the byte count it read from stdin as the answer.
    writeFileSync(
      bin,
      `#!/bin/sh\n[ "$1" = "--list-models" ] && exit 0\nn=$(wc -c)\necho '{"type":"system","subtype":"init","session_id":"s1"}'\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"result\\":\\"$n\\",\\"session_id\\":\\"s1\\"}"\n`,
    );
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_AGENT_BIN = bin;
    const input: RunInput = { selection: { provider: "agent", model: "m", cwd: dir, access: "full" }, prompt };
    const r = await collect(agentProvider.run(input), input);
    expect(Number(r.text.trim())).toBeGreaterThanOrEqual(200_000);
  });

  it("moves a long agy prompt to stdin and keeps a short one in argv", () => {
    const sel = { provider: "antigravity", model: "m", cwd: "/tmp", access: "full" } as const;
    const long = agyArgs({ selection: sel, prompt });
    expect(long).toEqual(expect.arrayContaining(["--print=", "--input-format", "stream-json"]));
    expect(long.every((a) => a.length < 1000)).toBe(true);
    expect(JSON.parse(stdinPrompt({ selection: sel, prompt })!)).toEqual({ event: "user", message: { content: prompt } });
    expect(agyArgs({ selection: sel, prompt: "hi" })[0]).toBe("--print=hi");
    expect(stdinPrompt({ selection: sel, prompt: "hi" })).toBeUndefined();
  });
});

describe("serveNode", () => {
  it("answers a method fetch cannot represent instead of crashing", async () => {
    const { server, url } = await serveNode(async () => new Response("ok"), { port: 0 });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(url, { method: "TRACE" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(400);
      expect(await (await fetch(url)).text()).toBe("ok");
    } finally {
      server.close();
    }
  });
});
