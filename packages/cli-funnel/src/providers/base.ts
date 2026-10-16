import { Channel } from "../util/channel.js";
import { spawn, type ChildProcess } from "node:child_process";
import { childEnv, cliCommand, compareVersions, exec, firstUrl, parseVersion, resolveBinary, type ExecResult } from "../util/process.js";
import {
  FunnelError,
  type AuthStatus,
  type FinishReason,
  type FunnelEvent,
  type Installation,
  type LoginEvent,
  type LoginSession,
  type RunResult,
  type RunInput,
  type UpdateResult,
} from "../types.js";
import { parseJsonAnswer } from "./prompt.js";

export function binaryEnvVar(binary: string): string {
  return `CLI_FUNNEL_${binary.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`;
}

export function findBinary(binary: string): string | undefined {
  return resolveBinary(binary, binaryEnvVar(binary));
}

export async function detectInstallation(
  binary: string,
  testedRange: Installation["testedRange"],
  versionArgs: string[] = ["--version"],
): Promise<Installation> {
  const path = findBinary(binary);
  if (!path) return { installed: false, testedRange };
  const res = await exec(path, versionArgs, { timeoutMs: 10_000 }).catch(() => undefined);
  const version = res ? parseVersion(res.stdout + res.stderr) : undefined;
  const withinTestedRange =
    version === undefined
      ? undefined
      : compareVersions(version, testedRange.min) >= 0 &&
        (!testedRange.maxExclusive || compareVersions(version, testedRange.maxExclusive) < 0);
  return { installed: true, path, version, testedRange, withinTestedRange };
}

/** How long a login may wait for the user before it gives up. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Login by spawning the CLI's own login command and watching its output for a URL.
 * Providers with a different flow return their own LoginSession instead.
 * `opensBrowser` marks CLIs that open the sign-in page themselves, so `open-url` carries `opened: true`
 * and a host app does not open a second tab.
 */
export function spawnLogin(
  binary: string,
  args: string[],
  readStatus: () => Promise<AuthStatus>,
  opts: { env?: Record<string, string>; signal?: AbortSignal; opensBrowser?: boolean; timeoutMs?: number } = {},
): LoginSession {
  const channel = new Channel<LoginEvent>();
  const path = findBinary(binary);
  let child: ChildProcess | undefined;
  let cancelled = false;
  let finished = false;
  const finish = (event?: LoginEvent) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (event && !cancelled) channel.push(event);
    channel.end();
  };
  let timer: NodeJS.Timeout | undefined;

  if (!path) {
    finish({ type: "error", message: `${binary} is not installed.` });
  } else {
    const command = cliCommand(path, args);
    child = spawn(command.file, command.args, {
      env: childEnv(opts.env),
      signal: opts.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    child.stdin?.on("error", () => {});
    timer = setTimeout(() => {
      child?.kill("SIGTERM");
      finish({ type: "error", message: "Timed out waiting for sign-in." });
    }, opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
    const seen = new Set<string>();
    // Output arrives in arbitrary chunks. URLs are read from whole lines so a link split across two chunks is not
    // reported half-finished; a prompt waiting for input has no newline, so it is checked as it arrives.
    const pending = { stdout: "", stderr: "" };
    const scanLine = (line: string) => {
      const url = firstUrl(line);
      if (url && !seen.has(url)) {
        seen.add(url);
        channel.push(opts.opensBrowser ? { type: "open-url", url, opened: true } : { type: "open-url", url });
      }
    };
    const scan = (stream: "stdout" | "stderr", text: string) => {
      channel.push({ type: "log", text });
      pending[stream] += text;
      const lines = pending[stream].split(/\r?\n/);
      pending[stream] = lines.pop() ?? "";
      for (const line of lines) scanLine(line);
      if (/paste|enter (the )?code|verification code/i.test(text)) {
        channel.push({ type: "code-prompt", message: text.trim() });
      }
    };
    child.stdout?.on("data", (d) => scan("stdout", String(d)));
    child.stderr?.on("data", (d) => scan("stderr", String(d)));
    // Without this listener a CLI that fails to start (missing file, permissions) throws in the host process.
    child.on("error", (error) => finish({ type: "error", message: error.message }));
    child.on("close", async (code) => {
      scanLine(pending.stdout);
      scanLine(pending.stderr);
      if (finished) return;
      const status = await readStatus().catch((): AuthStatus => ({ loggedIn: false }));
      finish(status.loggedIn ? { type: "done", status } : { type: "error", message: `Login did not complete (exit ${code}).` });
    });
  }

  return {
    [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
    sendCode: (code) => child?.stdin?.write(code + "\n"),
    // A cancelled login ends quietly: the caller asked for it, so it gets no error event.
    cancel: () => {
      cancelled = true;
      child?.kill("SIGTERM");
      finish();
    },
  };
}

/** Runs the CLI's own updater and reports the version before and after. */
export async function runUpdate(
  binary: string,
  updateArgs: string[],
  versionArgs: string[] = ["--version"],
): Promise<UpdateResult> {
  const path = findBinary(binary);
  if (!path) return { changed: false, output: `${binary} is not installed.` };
  const read = async () => {
    const r = await exec(path, versionArgs, { timeoutMs: 10_000 }).catch(() => undefined);
    return r ? parseVersion(r.stdout + r.stderr) : undefined;
  };
  const from = await read();
  const res = await exec(path, updateArgs, { timeoutMs: 600_000 });
  if (res.code !== 0) throw cliFailure(binary, "update", res);
  const to = await read();
  return { from, to, changed: !!from && !!to && from !== to, output: (res.stdout + res.stderr).trim() };
}

export async function runLogout(binary: string, args: string[]): Promise<void> {
  const path = findBinary(binary);
  if (!path) return;
  const res = await exec(path, args, { timeoutMs: 30_000 });
  if (res.code !== 0) throw cliFailure(binary, "logout", res);
}

/** The error for a CLI command that failed. A null code means the timeout killed it. */
function cliFailure(binary: string, action: string, res: ExecResult): FunnelError {
  const detail = (res.stderr.trim() || res.stdout.trim()).slice(0, 500);
  return new FunnelError(detail || `${binary} ${action} failed (exit ${res.code}).`, "cli-failed");
}

/** Folds events into an API-shaped result one at a time, so a caller never has to keep the events themselves. */
export interface RunFolder {
  /** Throws on an `error` event. */
  add(event: FunnelEvent): void;
  /** `finishReason` replaces the one the events carried, for a run that was cut off before its terminal event. */
  finish(finishReason?: FinishReason): RunResult;
}

export function createRunFolder(input: RunInput): RunFolder {
  const result: RunResult = {
    text: "",
    provider: input.selection.provider,
    model: input.selection.model,
    finishReason: "stop",
    toolCalls: [],
    deniedActions: [],
  };
  const tools = new Map<string, RunResult["toolCalls"][number]>();
  return {
    add(e) {
      switch (e.type) {
        case "session":
          result.sessionId = e.sessionId;
          if (e.model) result.model = e.model;
          break;
        case "text.delta":
          result.text += e.text;
          break;
        case "tool.start": {
          const call = { id: e.id, name: e.name, input: e.input };
          tools.set(e.id, call);
          result.toolCalls.push(call);
          break;
        }
        case "tool.end": {
          const call = tools.get(e.id);
          if (call && e.error) call.error = e.error;
          if (e.error?.startsWith("denied:")) result.deniedActions.push(call?.name ?? e.error.slice(7).trim());
          break;
        }
        case "tool_call":
          (result.pendingToolCalls ??= []).push({ id: e.id, name: e.name, input: e.input });
          break;
        case "usage":
          result.usage = e.usage;
          break;
        case "limit": {
          const { type: _, ...limit } = e;
          result.limit ??= limit;
          break;
        }
        case "retry":
          result.retries = (result.retries ?? 0) + 1;
          break;
        case "structured":
          result.structured = e.data;
          break;
        case "done":
          if (e.text) result.text = e.text;
          result.finishReason = e.finishReason;
          if (e.timeout) result.timeout = true;
          break;
        case "error":
          result.finishReason = "error";
          throw Object.assign(new Error(e.message), { code: e.code, ...(result.limit ? { limit: result.limit } : {}) });
      }
    },
    finish(finishReason) {
      if (finishReason) result.finishReason = finishReason;
      if (input.responseSchema && result.structured === undefined && (result.finishReason === "stop" || result.finishReason === "length")) {
        try {
          result.structured = parseJsonAnswer(result.text);
        } catch (err) {
          result.structuredError = `The answer is not JSON: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      return result;
    },
  };
}

/** Folds an event stream into an API-shaped result. */
export async function collect(
  events: AsyncIterable<FunnelEvent>,
  input: RunInput,
): Promise<RunResult> {
  const folder = createRunFolder(input);
  for await (const e of events) folder.add(e);
  return folder.finish();
}
