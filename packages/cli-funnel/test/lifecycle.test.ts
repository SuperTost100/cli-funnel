import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProvider } from "../src/providers/claude/index.js";
import { Channel } from "../src/util/channel.js";
import { readNDJSON } from "../src/util/ndjson.js";
import { spawnStream, terminate } from "../src/util/process.js";
import { readSSE } from "../src/util/sse.js";
import type { FunnelEvent, RunInput } from "../src/types.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-life-"));
  const file = join(dir, "cli");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("Channel", () => {
  it("rejects a reader that is already waiting when it fails", async () => {
    const channel = new Channel<number>();
    const next = channel[Symbol.asyncIterator]().next();
    channel.fail(new Error("spawn failed"));
    await expect(next).rejects.toThrow("spawn failed");
  });

  it("makes a spawn error end the stream with that error", async () => {
    const proc = spawnStream(join(tmpdir(), "does-not-exist-cli"), []);
    const read = async () => {
      for await (const _ of proc.lines) {
        /* nothing arrives */
      }
    };
    await expect(read()).rejects.toThrow(/ENOENT/);
  });
});

describe("child processes", () => {
  it("kills a CLI that ignores SIGTERM after the grace period", async () => {
    const proc = spawnStream(script(`trap '' TERM\necho '{"ready":true}'\nwhile :; do sleep 0.1; done`), []);
    for await (const _ of proc.lines) break;
    terminate(proc.child, 200);
    expect(await Promise.race([proc.exited.then(() => "exited"), new Promise((r) => setTimeout(() => r("hung"), 3000))])).toBe("exited");
  });

  it("kills the processes the CLI started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-grand-"));
    const pidFile = join(dir, "pid");
    const proc = spawnStream(script(`sleep 30 &\necho $! > "${pidFile}"\necho '{"ready":true}'\nwait`), []);
    for await (const _ of proc.lines) break;
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(alive(grandchild)).toBe(true);
    proc.kill();
    await proc.exited;
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  });

  it("removes its abort listener when the process exits on its own", async () => {
    const controller = new AbortController();
    for (let i = 0; i < 3; i++) {
      const proc = spawnStream(script("exit 0"), [], { signal: controller.signal });
      await proc.exited;
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("claude process lifetime", () => {
  afterEach(() => {
    delete process.env.CLI_FUNNEL_CLAUDE_BIN;
  });
  const input = (over: Partial<RunInput> = {}): RunInput => ({
    selection: { provider: "claude", model: "m", cwd: tmpdir(), access: "accept-edits" },
    prompt: "x",
    ...over,
  });

  it("exits when the consumer stops at done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-claude-"));
    const mark = join(dir, "exited");
    // Answers one turn, then waits for more input until stdin closes, like Claude Code in stream-json mode.
    process.env.CLI_FUNNEL_CLAUDE_BIN = script(
      `read line\necho '{"type":"result","subtype":"success","is_error":false,"result":"hi"}'\ncat >/dev/null\ntouch "${mark}"`,
    );
    for await (const e of claudeProvider.run(input())) if (e.type === "done") break;
    expect(await waitFor(() => existsSync(mark))).toBe(true);
  });

  describe("long system prompts", () => {
    const BIG = "x".repeat(200_000);
    // Records every argument and, for the system prompt file flag, the file's size, its mode and its folder's mode.
    const recorder = (log: string) =>
      script(
        `read line
prev=""
for a in "$@"; do
  echo "\${#a}:$(printf %s "$a" | cut -c1-30)" >> "${log}.args"
  if [ "$prev" = "--append-system-prompt-file" ] || [ "$prev" = "--system-prompt-file" ]; then
    echo "$prev" >> "${log}.file"; echo "$a" >> "${log}.file"
    wc -c < "$a" >> "${log}.file"; stat -c %a "$a" >> "${log}.file"; stat -c %a "$(dirname "$a")" >> "${log}.file"
  fi
  prev="$a"
done
echo '{"type":"result","subtype":"success","is_error":false,"result":"hi"}'
cat >/dev/null`,
      );

    it("passes a 200 KB system prompt as a private file and removes it after the run", async () => {
      const log = join(mkdtempSync(join(tmpdir(), "cf-claude-")), "log");
      process.env.CLI_FUNNEL_CLAUDE_BIN = recorder(log);
      for await (const _ of claudeProvider.run(input({ system: BIG }))) {
        /* drain */
      }
      const [flag, path, size, fileMode, dirMode] = readFileSync(`${log}.file`, "utf8").trim().split("\n");
      expect(flag).toBe("--append-system-prompt-file");
      expect(Number(size)).toBe(BIG.length);
      expect(fileMode).toBe("600");
      expect(dirMode).toBe("700");
      expect(existsSync(path!)).toBe(false);
      const lengths = readFileSync(`${log}.args`, "utf8").trim().split("\n").map((l) => Number(l.split(":")[0]));
      expect(Math.max(...lengths)).toBeLessThan(1000);
    });

    it("uses --system-prompt-file for none and keeps a short prompt inline", async () => {
      const log = join(mkdtempSync(join(tmpdir(), "cf-claude-")), "log");
      process.env.CLI_FUNNEL_CLAUDE_BIN = recorder(log);
      for await (const _ of claudeProvider.run(input({ system: BIG, selection: { provider: "claude", model: "m", cwd: tmpdir(), access: "none" } }))) {
        /* drain */
      }
      expect(readFileSync(`${log}.file`, "utf8").split("\n")[0]).toBe("--system-prompt-file");
      const short = join(mkdtempSync(join(tmpdir(), "cf-claude-")), "log");
      process.env.CLI_FUNNEL_CLAUDE_BIN = recorder(short);
      for await (const _ of claudeProvider.run(input({ system: "Be terse." }))) {
        /* drain */
      }
      expect(existsSync(`${short}.file`)).toBe(false);
      expect(readFileSync(`${short}.args`, "utf8")).toContain("9:Be terse.");
    });
  });

  it("ends as cancelled when aborted while an approval is pending", async () => {
    process.env.CLI_FUNNEL_CLAUDE_BIN = script(
      `read line\necho '{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t1"}}'\ncat >/dev/null`,
    );
    const controller = new AbortController();
    const events: FunnelEvent[] = [];
    const run = (async () => {
      for await (const e of claudeProvider.run(input({ signal: controller.signal, onApproval: () => new Promise(() => {}) }))) {
        events.push(e);
        if (e.type === "approval.request") controller.abort();
      }
      return "finished";
    })();
    expect(await Promise.race([run, new Promise((r) => setTimeout(() => r("hung"), 3000))])).toBe("finished");
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "cancelled" });
  });
});

describe("fetch readers", () => {
  const endless = (chunk: string) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode(chunk));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { res: new Response(body), cancelled: () => cancelled };
  };

  it("cancels an SSE body when the reader stops early", async () => {
    const { res, cancelled } = endless("data: {}\n\n");
    for await (const _ of readSSE(res)) break;
    expect(cancelled()).toBe(true);
  });

  it("cancels an NDJSON body when the reader stops early", async () => {
    const { res, cancelled } = endless("{}\n");
    for await (const _ of readNDJSON(res)) break;
    expect(cancelled()).toBe(true);
  });
});
