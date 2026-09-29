import { Channel } from "../util/channel.js";
import { spawn, type ChildProcess } from "node:child_process";
import { compareVersions, exec, firstUrl, parseVersion, resolveBinary } from "../util/process.js";
import type {
  AuthStatus,
  FunnelEvent,
  Installation,
  LoginEvent,
  LoginSession,
  RunResult,
  RunInput,
  UpdateResult,
} from "../types.js";

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

/**
 * Login by spawning the CLI's own login command and watching its output for a URL.
 * Providers with a different flow return their own LoginSession instead.
 */
export function spawnLogin(
  binary: string,
  args: string[],
  readStatus: () => Promise<AuthStatus>,
  opts: { env?: Record<string, string>; signal?: AbortSignal } = {},
): LoginSession {
  const channel = new Channel<LoginEvent>();
  const path = findBinary(binary);
  let child: ChildProcess | undefined;

  if (!path) {
    channel.push({ type: "error", message: `${binary} is not installed.` });
    channel.end();
  } else {
    child = spawn(path, args, { env: { ...process.env, ...opts.env }, signal: opts.signal, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin?.on("error", () => {});
    const seen = new Set<string>();
    const scan = (text: string) => {
      channel.push({ type: "log", text });
      const url = firstUrl(text);
      if (url && !seen.has(url)) {
        seen.add(url);
        channel.push({ type: "open-url", url });
      }
      if (/paste|enter (the )?code|verification code/i.test(text)) {
        channel.push({ type: "code-prompt", message: text.trim() });
      }
    };
    child.stdout?.on("data", (d) => scan(String(d)));
    child.stderr?.on("data", (d) => scan(String(d)));
    child.on("close", async (code) => {
      const status = await readStatus().catch((): AuthStatus => ({ loggedIn: false }));
      if (status.loggedIn) channel.push({ type: "done", status });
      else channel.push({ type: "error", message: `Login did not complete (exit ${code}).` });
      channel.end();
    });
  }

  return {
    [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
    sendCode: (code) => child?.stdin?.write(code + "\n"),
    cancel: () => child?.kill("SIGTERM"),
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
  const to = await read();
  return { from, to, changed: !!from && !!to && from !== to, output: (res.stdout + res.stderr).trim() };
}

export async function runLogout(binary: string, args: string[]): Promise<void> {
  const path = findBinary(binary);
  if (path) await exec(path, args, { timeoutMs: 30_000 });
}

/** Folds an event stream into an API-shaped result. */
export async function collect(
  events: AsyncIterable<FunnelEvent>,
  input: RunInput,
): Promise<RunResult> {
  const result: RunResult = {
    text: "",
    provider: input.selection.provider,
    model: input.selection.model,
    finishReason: "stop",
    toolCalls: [],
    deniedActions: [],
  };
  const tools = new Map<string, RunResult["toolCalls"][number]>();
  for await (const e of events) {
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
      case "usage":
        result.usage = e.usage;
        break;
      case "done":
        if (e.text) result.text = e.text;
        result.finishReason = e.finishReason;
        break;
      case "error":
        result.finishReason = "error";
        throw Object.assign(new Error(e.message), { code: e.code });
    }
  }
  return result;
}
