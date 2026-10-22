import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnLogin } from "../src/providers/base.js";
import { collect } from "./helpers.js";
import { createApiProviders } from "../src/providers/api.js";
import { parseClaudeMessage } from "../src/providers/claude/parser.js";
import { Translator } from "../src/providers/codex/events.js";
import { codexProvider } from "../src/providers/codex/index.js";
import { cliCommand, cmdQuote, firstUrl, shimTarget } from "../src/util/process.js";
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
    { type: "message_stop" },
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
  // Retries are off so the failed turn is one request and not three.
  const provider = () => createApiProviders({ anthropic: "k" }, { anthropic: { retries: 0 } })["anthropic-api"];
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
    const anthropic = events([{ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } }, { type: "message_stop" }]);
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
      // The pid goes first: once the session line is out, the caller may stop the CLI before its next line runs.
      `#!/bin/sh\n[ "$1" = "--list-models" ] && exit 0\necho $$ > ${pidFile}\necho '{"type":"system","subtype":"init","session_id":"s1"}'\nexec sleep 30\n`,
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

describe("login links", () => {
  it("skips the CLI's own loopback callback and returns the sign-in link", () => {
    const text =
      "Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?client_id=x&state=y\n";
    expect(firstUrl(text)).toBe("https://auth.openai.com/oauth/authorize?client_id=x&state=y");
    expect(firstUrl("Listening on http://127.0.0.1:8080/callback")).toBeUndefined();
    expect(firstUrl("Open https://claude.ai/oauth/authorize?code=true")).toBe("https://claude.ai/oauth/authorize?code=true");
  });
});

describe.skipIf(process.platform === "win32")("codex login", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_CODEX_BIN;
  });

  // A stand-in codex that records its arguments and prints what `codex login` prints.
  function fakeCodex() {
    const dir = mkdtempSync(join(tmpdir(), "cf-codex-"));
    const bin = join(dir, "codex");
    const args = join(dir, "args");
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1 $2" = "login status" ]; then echo "Not logged in" >&2; exit 1; fi\necho "$@" > ${args}\nprintf 'Starting local login server on http://localhost:1455.\\nIf your browser did not open, navigate to this URL to authenticate:\\n\\nhttps://auth.openai.com/oauth/authorize?state=z\\n' >&2\n`,
    );
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_CODEX_BIN = bin;
    return args;
  }
  async function events(device?: boolean) {
    const seen = [];
    for await (const e of codexProvider.login({ device })) if (e.type !== "log") seen.push(e);
    return seen;
  }

  it("uses the browser login and reports the sign-in link, not the local callback", async () => {
    const args = fakeCodex();
    const seen = await events();
    expect(readFileSync(args, "utf8").trim()).toBe("login");
    expect(seen.filter((e) => e.type === "open-url")).toEqual([
      { type: "open-url", url: "https://auth.openai.com/oauth/authorize?state=z", opened: true },
    ]);
  });

  it("uses a device code only when asked", async () => {
    const args = fakeCodex();
    await events(true);
    expect(readFileSync(args, "utf8").trim()).toBe("login --device-auth");
  });
});

describe("windows commands", () => {
  it("quotes arguments for cmd.exe like cross-spawn", () => {
    expect(cmdQuote("plain")).toBe('^"plain^"');
    expect(cmdQuote('say "hi" & exit')).toBe('^"say^ \\^"hi\\^"^ ^&^ exit^"');
    expect(cmdQuote("C:\\dir\\")).toBe('^"C:\\dir\\\\^"');
  });

  it("finds the script an npm shim runs", () => {
    const shim = '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
    expect(shimTarget("C:\\npm\\codex.cmd", shim)).toBe("C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js");
    expect(shimTarget("C:\\x\\run.cmd", "@echo off\r\nstart something")).toBeUndefined();
  });

  it("leaves executables alone and wraps other batch files in cmd.exe", () => {
    expect(cliCommand("C:\\x\\codex.exe", ["login"], "win32")).toEqual({ file: "C:\\x\\codex.exe", args: ["login"] });
    expect(cliCommand("/usr/bin/codex.cmd", ["login"], "linux")).toEqual({ file: "/usr/bin/codex.cmd", args: ["login"] });
    const wrapped = cliCommand("C:\\missing dir\\tool.bat", ["a b"], "win32");
    expect(wrapped.windowsVerbatimArguments).toBe(true);
    expect(wrapped.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(wrapped.args[3]).toBe('"C:\\missing^ dir\\tool.bat ^"a^ b^""');
  });
});

describe.skipIf(process.platform === "win32")("sign-in process", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_CODEX_BIN;
  });
  function fake(body: string) {
    const dir = mkdtempSync(join(tmpdir(), "cf-login-"));
    const bin = join(dir, "codex");
    writeFileSync(bin, `#!/bin/sh\nif [ "$1 $2" = "login status" ]; then echo "Not logged in" >&2; exit 1; fi\n${body}\n`);
    chmodSync(bin, 0o755);
    process.env.CLI_FUNNEL_CODEX_BIN = bin;
    return bin;
  }

  it("marks the link as opened when the CLI opens the browser itself", async () => {
    fake("printf 'https://auth.openai.com/oauth/au' >&2; sleep 0.2; printf 'thorize?state=z\\n' >&2");
    const seen = [];
    for await (const e of codexProvider.login()) if (e.type === "open-url") seen.push(e);
    // The link arrived in two chunks; only the complete one is reported.
    expect(seen).toEqual([{ type: "open-url", url: "https://auth.openai.com/oauth/authorize?state=z", opened: true }]);
  });

  it("ends quietly when cancelled", async () => {
    fake("sleep 30");
    const session = codexProvider.login();
    const events: string[] = [];
    const done = (async () => {
      for await (const e of session) events.push(e.type);
    })();
    setTimeout(() => session.cancel(), 100);
    await done;
    expect(events).not.toContain("error");
  });

  it("reports a CLI that cannot start instead of throwing", async () => {
    const bin = fake("exit 0");
    chmodSync(bin, 0o644);
    const events = [];
    for await (const e of codexProvider.login()) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("gives up after the login timeout", async () => {
    fake("sleep 30");
    const events = [];
    for await (const e of spawnLogin("codex", ["login"], async () => ({ loggedIn: false }), { timeoutMs: 200 })) events.push(e);
    expect(events.at(-1)).toEqual({ type: "error", message: "Timed out waiting for sign-in." });
  });

  it("stops a running login when the host process exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-login-host-"));
    const pidFile = join(dir, "pid");
    fake(`echo $$ > ${pidFile}; sleep 30`);
    // The host is bundled from source so it runs on plain Node. It starts a login and exits once the CLI runs.
    const { build } = await import("esbuild");
    const host = join(dir, "host.mjs");
    const base = fileURLToPath(new URL("../src/providers/base.ts", import.meta.url));
    const contents = `import { existsSync } from "node:fs";
import { spawnLogin } from ${JSON.stringify(base)};
spawnLogin("codex", ["login"], async () => ({ loggedIn: false }));
setInterval(() => existsSync(${JSON.stringify(pidFile)}) && process.exit(0), 20);`;
    await build({ stdin: { contents, resolveDir: dir }, bundle: true, platform: "node", format: "esm", outfile: host, logLevel: "silent" });
    execFileSync(process.execPath, [host], { timeout: 10_000 });
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const end = Date.now() + 3000;
    while (alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    const survived = alive();
    if (survived) process.kill(pid, "SIGKILL");
    expect(survived).toBe(false);
  });
});
