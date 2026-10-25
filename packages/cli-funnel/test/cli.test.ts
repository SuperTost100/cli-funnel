import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeShCli } from "./fake-cli.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const MODEL = "claude-opus-5-5";

// A claude that answers in stream-json. FAKE=ok gives a plain answer. Otherwise it wants to run Bash:
// with --permission-prompt-tool it asks first, without it the tool is denied by the CLI itself.
const FAKE_CLAUDE = `case "$1" in --version) echo "2.1.283 (Claude Code)"; exit 0;; esac
read -r prompt
echo '{"type":"system","subtype":"init","session_id":"s1"}'
if [ "$FAKE" = ok ]; then
  echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}}'
  echo '{"type":"result","subtype":"success","result":"hello","session_id":"s1","is_error":false,"permission_denials":[]}'
  exit 0
fi
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}'
case "$*" in
  *--permission-prompt-tool*)
    echo '{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t1"}}'
    read -r answer
    case "$answer" in
      *'"allow"'*)
        echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}}'
        echo '{"type":"result","subtype":"success","result":"hello","session_id":"s1","is_error":false,"permission_denials":[]}' ;;
      *) echo '{"type":"result","subtype":"success","result":"","session_id":"s1","is_error":false,"permission_denials":[{"tool_name":"Bash","tool_use_id":"t1"}]}' ;;
    esac ;;
  *) echo '{"type":"result","subtype":"success","result":"","session_id":"s1","is_error":false,"permission_denials":[{"tool_name":"Bash","tool_use_id":"t1"}]}' ;;
esac
`;

let work: string;
let cli: string;
let claude: string;

beforeAll(async () => {
  // Inside the package so the bundle finds data/models the same way dist/ does.
  work = mkdtempSync(join(root, ".cli-test-"));
  await build({ entry: { cli: join(root, "src/bin/cli.ts") }, outDir: work, format: ["esm"], target: "node22", dts: false, silent: true, config: false });
  cli = join(work, "cli.js");
  claude = fakeShCli(join(work, "claude"), FAKE_CLAUDE);
  mkdirSync(join(work, "state"));
}, 60_000);

afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, CLI_FUNNEL_CLAUDE_BIN: claude, XDG_STATE_HOME: join(work, "state"), ...opts.env },
      cwd: work,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    // Readline refuses a question once stdin has ended, so the answer goes in after the prompt appears.
    child.stderr.on("data", (d) => {
      stderr += d;
      if (opts.stdin && stderr.includes("[y/N]")) child.stdin.end(opts.stdin);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (!opts.stdin) child.stdin.end();
  });
}

describe("cli run", () => {
  it("denies a tool that needs approval at the default access level instead of crashing", async () => {
    const r = await runCli(["run", "claude", MODEL, "list files"]);
    expect(r.stderr).not.toContain("Cannot read properties");
    expect(r.stderr).toContain("Denied: Bash");
    expect(r.stderr).toContain("Finish reason: denied");
    expect(r.code).toBe(1);
  });

  it("asks on the terminal at supervised access and keeps stdout for the answer", async () => {
    const r = await runCli(["run", "claude", MODEL, "list files", "--access", "supervised"], { stdin: "y\n" });
    expect(r.stderr).toContain("Allow Bash");
    expect(r.stdout.trim()).toBe("hello");
    expect(r.code).toBe(0);
  });

  it("exits 1 when a supervised request is refused and no text comes back", async () => {
    const r = await runCli(["run", "claude", MODEL, "list files", "--access", "supervised"], { stdin: "n\n" });
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain("Finish reason: denied");
    expect(r.code).toBe(1);
  });

  it("prints only the JSON on stdout with --json", async () => {
    const r = await runCli(["run", "claude", MODEL, "hi", "--json"], { env: { FAKE: "ok" } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ text: "hello", finishReason: "stop" });
  });

  it("streams the text and exits 0 on a normal run", async () => {
    const r = await runCli(["run", "claude", MODEL, "hi"], { env: { FAKE: "ok" } });
    expect(r.stdout).toBe("hello\n");
    expect(r.code).toBe(0);
  });

  it.each([
    [["--max-tokens", "abc"], "--max-tokens"],
    [["--max-tokens", "1.5"], "--max-tokens"],
    [["--context", "abc"], "--context"],
    [["--context=-5"], "--context"],
  ])("rejects %j with exit 2", async (flags, name) => {
    const r = await runCli(["run", "claude", MODEL, "hi", ...flags]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(name);
  });
});

describe("cli usage errors", () => {
  it.each([
    [["run", "claude", MODEL], "Usage: cli-funnel run"],
    [["run", "nope", MODEL, "hi"], "Pick a provider"],
    [["pull", "claude"], "Usage: cli-funnel pull"],
    [["rm", "claude"], "Usage: cli-funnel rm"],
    [["bogus"], "cli-funnel <command>"],
    [[], "cli-funnel <command>"],
  ])("%j goes to stderr with exit 2", async (args, text) => {
    const r = await runCli(args);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(text);
  });

  it("prints help on stdout with exit 0 and lists --json", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--json");
  });
});

describe("cli serve", () => {
  it("refuses a public address without a token", async () => {
    const r = await runCli(["serve", "--host", "0.0.0.0", "--port", "0"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--token");
  });

  it("rejects bad session and queue flags with exit 2", async () => {
    const cases: [string, string, string][] = [["--max-concurrent", "0", "--max-concurrent"], ["--session-idle", "30", "--keep-alive"], ["--max-queued", "5", "--max-concurrent"]];
    for (const [flag, value, want] of cases) {
      const r = await runCli(["serve", "--port", "0", flag, value]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(want);
    }
  });

  it("serves /sessions with --keep-alive and answers 409 without it", async () => {
    const start = async (extra: string[]) => {
      const child = spawn(process.execPath, [cli, "serve", "--port", "0", ...extra], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
      const url = await new Promise<string>((resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => reject(new Error(`no output: ${text}`)), 10_000);
        child.stdout.on("data", (d) => {
          text += d;
          const m = /listening on (http:\/\/\S+)/.exec(text);
          if (m?.[1]) (clearTimeout(timer), resolve(m[1]));
        });
        child.stderr.on("data", (d) => (text += d));
      }).catch((err) => (child.kill(), Promise.reject(err)));
      return { url, stop: () => child.kill() };
    };
    const on = await start(["--keep-alive", "--max-sessions", "2", "--max-concurrent", "1"]);
    const off = await start([]);
    try {
      const live = await fetch(`${on.url}/sessions`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual([]);
      expect((await fetch(`${off.url}/sessions`)).status).toBe(409);
    } finally {
      on.stop();
      off.stop();
    }
  });

  // Windows cannot deliver SIGTERM to a handler: kill() ends the process at once, so there is no shutdown to test.
  it.skipIf(process.platform === "win32")("writes the run log before it exits on SIGTERM", async () => {
    const log = join(work, "runs.jsonl");
    const child = spawn(process.execPath, [cli, "serve", "--port", "0", "--log-jsonl", log], {
      cwd: work,
      env: { ...process.env, CLI_FUNNEL_CLAUDE_BIN: claude, XDG_STATE_HOME: join(work, "state"), FAKE: "ok" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => reject(new Error(`no output: ${text}`)), 10_000);
        child.stdout.on("data", (d) => {
          text += d;
          const m = /listening on (http:\/\/\S+)/.exec(text);
          if (m?.[1]) (clearTimeout(timer), resolve(m[1]));
        });
        child.stderr.on("data", (d) => (text += d));
      });
      const res = await fetch(`${url}/run`, {
        method: "POST",
        body: JSON.stringify({ selection: { provider: "claude", model: MODEL, cwd: work, access: "full" }, prompt: "hi" }),
      });
      expect(await res.text()).toContain('"type":"done"');
    } finally {
      child.kill("SIGTERM");
    }
    expect(await closed).toBe(143);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it.each(["::1", "[::1]"])("treats %s as local", async (host) => {
    const child = spawn(process.execPath, [cli, "serve", "--host", host, "--port", "0"], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    const line = await new Promise<string>((resolve, reject) => {
      let text = "";
      const done = (v: string) => (clearTimeout(timer), resolve(v));
      const timer = setTimeout(() => reject(new Error(`no output: ${text}`)), 10_000);
      child.stdout.on("data", (d) => (text += d) && text.includes("\n") && done(text));
      child.stderr.on("data", (d) => (text += d));
      child.on("close", () => done(text));
    }).finally(() => child.kill());
    expect(line).toMatch(/listening on http:\/\/\[::1\]:\d+/);
  });
});
