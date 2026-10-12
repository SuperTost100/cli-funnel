import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, win32 } from "node:path";
import { Channel } from "./channel.js";

const EXTRA_DIRS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".cursor", "bin"),
  join(homedir(), ".npm-global", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

const MARK = "__CLI_FUNNEL_ENV__";
let shellPath: string[] | undefined;

/**
 * PATH as the user's login shell sets it, read once and cached. An app started from the macOS Dock,
 * Finder or a Linux desktop launcher inherits a minimal PATH without nvm, asdf, pnpm or Homebrew,
 * and then cannot find CLIs, or `node` for CLIs that are Node scripts. Windows GUI apps get the full
 * PATH already, so nothing runs there. Set CLI_FUNNEL_NO_SHELL_PATH=1 to skip it.
 */
export function loginShellPath(refresh = false): string[] {
  if (shellPath && !refresh) return shellPath;
  shellPath = [];
  if (process.platform === "win32" || process.env.CLI_FUNNEL_NO_SHELL_PATH === "1") return shellPath;
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  try {
    // `env` prints PATH colon-separated in every shell, fish included. The markers skip anything
    // the user's rc files print. stdin is closed so an interactive shell cannot wait for input.
    const out = execFileSync(shell, ["-ilc", `echo ${MARK}; /usr/bin/env; echo ${MARK}`], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split(MARK)[1]?.split("\n").find((l) => l.startsWith("PATH="));
    if (line) shellPath = line.slice(5).split(":").filter(Boolean);
  } catch {
    /* a broken or slow rc file leaves the process PATH as it was */
  }
  return shellPath;
}

/** Directories searched for CLIs, in order: the process PATH, the login shell PATH, then common install dirs. */
export function searchPath(): string[] {
  return [...new Set([...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...loginShellPath(), ...EXTRA_DIRS])];
}

/** Environment for a child CLI: the full search path, so Node-based CLIs find `node` too. */
export function childEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...process.env, PATH: searchPath().join(delimiter), ...extra };
}

/** Finds a CLI on PATH, the login shell PATH and the usual install dirs. GUI apps often start with a thin PATH. */
export function resolveBinary(name: string, envVar?: string): string | undefined {
  const override = envVar ? process.env[envVar] : undefined;
  if (override && existsSync(override)) return override;
  const dirs = searchPath();
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

// Characters cmd.exe treats specially. Each one is escaped with ^ once the argument is quoted.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quotes one argument for `cmd.exe /d /s /c`, the way cross-spawn does. */
export function cmdQuote(arg: string): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  out = `"${out}"`;
  return out.replace(CMD_META, "^$1");
}

/**
 * The script an npm `.cmd` shim runs, so it can be started with Node directly. npm writes
 * `"%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*`; anything else returns undefined.
 */
export function shimTarget(shimPath: string, text?: string): string | undefined {
  let body = text;
  if (body === undefined) {
    try {
      body = readFileSync(shimPath, "utf8");
    } catch {
      return undefined;
    }
  }
  const match = body.match(/"%dp0%\\([^"]+\.(?:c|m)?js)"\s+%\*/i);
  return match ? win32.join(win32.dirname(shimPath), match[1]!) : undefined;
}

export interface Command {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * How to start a CLI. Node refuses to spawn `.cmd` and `.bat` files without a shell (CVE-2024-27980), and npm installs
 * Codex and Claude Code on Windows as `.cmd` shims. A shim is run as `node script.js`, which also avoids cmd.exe's
 * 8191-character line limit. Any other batch file goes through `cmd.exe /d /s /c` with every argument quoted.
 */
export function cliCommand(file: string, args: string[], platform: NodeJS.Platform = process.platform): Command {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) return { file, args };
  const script = shimTarget(file);
  if (script) {
    const bundled = win32.join(win32.dirname(file), "node.exe");
    return { file: existsSync(bundled) ? bundled : (resolveBinary("node") ?? "node"), args: [script, ...args] };
  }
  const line = [file.replace(CMD_META, "^$1"), ...args.map(cmdQuote)].join(" ");
  return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Runs a command to completion. Never throws on a non-zero exit. */
export function exec(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const command = cliCommand(file, args);
    const child = spawn(command.file, command.args, {
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      cwd: opts.cwd,
      env: childEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

export interface Streamed {
  child: ChildProcess;
  /** Parsed JSON objects from stdout, one per line. Non-JSON lines are yielded as `{ __raw: line }`. */
  lines: AsyncIterable<unknown>;
  /** Collected stderr so far. */
  stderr(): string;
  /** Resolves when the process exits. */
  exited: Promise<number | null>;
  write(line: string): void;
  closeStdin(): void;
}

/** Spawns a CLI and exposes stdout as an NDJSON stream. Aborting the signal sends SIGTERM. */
export function spawnStream(
  file: string,
  args: string[],
  opts: ExecOptions & { closeStdin?: boolean } = {},
): Streamed {
  const command = cliCommand(file, args);
  const child = spawn(command.file, command.args, {
    windowsVerbatimArguments: command.windowsVerbatimArguments,
    cwd: opts.cwd,
    env: childEnv(opts.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const channel = new Channel<unknown>();
  let buffer = "";
  let stderr = "";

  const flush = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      channel.push(JSON.parse(trimmed));
    } catch {
      channel.push({ __raw: trimmed });
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      flush(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => (stderr += d));
  child.stdin.on("error", () => {});

  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (e) => {
      channel.fail(e);
      resolve(null);
    });
    child.on("close", (code) => {
      flush(buffer);
      buffer = "";
      channel.end();
      resolve(code);
    });
  });

  const onAbort = () => child.kill("SIGTERM");
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  if (opts.input !== undefined) child.stdin.write(opts.input);
  if (opts.closeStdin ?? opts.input !== undefined) child.stdin.end();

  return {
    child,
    lines: channel,
    stderr: () => stderr,
    exited,
    write: (line) => child.stdin.write(line.endsWith("\n") ? line : line + "\n"),
    closeStdin: () => child.stdin.end(),
  };
}

/**
 * The first URL in a login prompt that a person should open. Loopback URLs are skipped: they are the CLI's own
 * callback server, which `codex login` prints before the sign-in link.
 */
export function firstUrl(text: string): string | undefined {
  for (const [match] of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    // A URL that ends a sentence keeps the sentence's full stop.
    const url = match.replace(/[.,;:!?]+$/, "");
    const host = URL.canParse(url) ? new URL(url).hostname : "";
    if (!/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(host)) return url;
  }
  return undefined;
}

export function parseVersion(text: string): string | undefined {
  return text.match(/\d+\.\d+\.\d+(?:[-.][\w.]+)?/)?.[0] ?? text.match(/\d{4}\.\d{2}\.\d{2}[-\w]*/)?.[0];
}

/** Compares dotted numeric versions. Returns <0, 0 or >0. Non-numeric suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
