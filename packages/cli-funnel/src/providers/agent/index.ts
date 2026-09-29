import { fromManifest, loadBundledManifest } from "../../catalog/manifest.js";
import { compareVersions, exec, spawnStream } from "../../util/process.js";
import { detectInstallation, findBinary, runLogout, runUpdate, spawnLogin } from "../base.js";
import { FunnelError, type AuthStatus, type FunnelEvent, type ModelInfo, type Provider, type RunInput } from "../../types.js";
import { composePrompt } from "../prompt.js";
import { groupModels, parseModelList, parseStatus, StreamMapper, toCliModel } from "./parser.js";

const BINARY = "agent";
const TESTED_RANGE = { min: "2026.09.01" };

let known: Set<string> | undefined;

async function listModels(): Promise<{ id: string; name: string }[]> {
  const path = findBinary(BINARY);
  if (!path) return [];
  const res = await exec(path, ["--list-models"], { timeoutMs: 30_000 }).catch(() => undefined);
  return res ? parseModelList(res.stdout) : [];
}

async function knownIds(): Promise<Set<string>> {
  if (!known?.size) known = new Set((await listModels()).map((m) => m.id));
  return known;
}

/** Access maps to CLI flags. `accept-edits` has no flag and `supervised` has no approval passthrough, so neither is offered. */
export function accessFlags(access: RunInput["selection"]["access"]): string[] {
  if (access === "full") return ["--force"];
  if (access === "auto") return ["--auto-review"];
  throw new FunnelError(`Cursor Agent cannot enforce access "${access}". Supported: auto, full.`, "invalid-selection");
}

export function buildArgs(input: RunInput, model: string): string[] {
  const { selection } = input;
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--model",
    model,
    "--workspace",
    selection.cwd,
    "--trust",
    ...accessFlags(selection.access),
    ...(input.sessionId ? ["--resume", input.sessionId] : []),
    "--",
    composePrompt(input, { system: true, schema: true }),
  ];
}

async function authStatus(): Promise<AuthStatus> {
  const path = findBinary(BINARY);
  if (!path) return { loggedIn: false, detail: "agent is not installed." };
  const status = await exec(path, ["status", "--format", "json"], { timeoutMs: 15_000 }).catch(() => undefined);
  if (!status) return { loggedIn: false };
  const parsed = parseStatus(status.stdout || status.stderr);
  if (!parsed.loggedIn) return { loggedIn: false };
  const about = await exec(path, ["about", "--format", "json"], { timeoutMs: 15_000 }).catch(() => undefined);
  return parseStatus(status.stdout, about?.stdout);
}

async function* run(input: RunInput): AsyncGenerator<FunnelEvent> {
  const path = findBinary(BINARY);
  if (!path) throw new FunnelError("agent is not installed.", "not-installed");
  const model = toCliModel(input.selection, await knownIds());
  const args = buildArgs(input, model);
  const proc = spawnStream(path, args, { cwd: input.selection.cwd, env: input.env, signal: input.signal, closeStdin: true });
  const mapper = new StreamMapper();
  let finished = false;
  for await (const line of proc.lines) {
    for (const event of mapper.map(line)) {
      if (event.type === "done" || event.type === "error") finished = true;
      yield event;
    }
  }
  const code = await proc.exited;
  if (input.signal?.aborted) {
    yield { type: "done", text: "", finishReason: "cancelled" };
  } else if (!finished) {
    const detail = proc.stderr().trim().slice(-500);
    yield {
      type: "error",
      message: detail || `agent exited with code ${code} before finishing.`,
      code: /authentication required|not logged in/i.test(detail) ? "not-logged-in" : "cli-failed",
    };
  }
}

export const agentProvider: Provider = {
  id: "agent",
  displayName: "Cursor Agent",
  binary: BINARY,
  // No `none`: in testing, `--mode ask` with `--sandbox enabled` still ran shell commands, and only the model's own refusal stopped writes.
  capabilities: {
    access: ["auto", "full"],
    effort: true,
    contextWindow: false,
    fast: true,
    resume: true,
    approvals: false,
    images: false,
    system: "prompt",
    schema: "prompt",
  },
  detect: () => detectInstallation(BINARY, TESTED_RANGE),
  authStatus,
  login: (options) =>
    spawnLogin(BINARY, ["login"], authStatus, {
      signal: options?.signal,
      env: process.env.CLI_FUNNEL_OPEN_BROWSER === "1" ? {} : { NO_OPEN_BROWSER: "1" },
    }),
  logout: () => runLogout(BINARY, ["logout"]),
  update: () => runUpdate(BINARY, ["update"]),
  async models(): Promise<ModelInfo[]> {
    const listed = await listModels();
    if (listed.length) {
      known = new Set(listed.map((m) => m.id));
      return groupModels(listed);
    }
    return fromManifest(await loadBundledManifest(), "agent", undefined, compareVersions);
  },
  run,
};
