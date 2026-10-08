import { fromManifest, loadBundledManifest } from "../../catalog/manifest.js";
import { compareVersions, exec, spawnStream } from "../../util/process.js";
import { detectInstallation, findBinary, runLogout, runUpdate, spawnLogin } from "../base.js";
import { FunnelError, type AuthStatus, type FunnelEvent, type ModelInfo, type Provider, type RunInput } from "../../types.js";
import { composePrompt } from "../prompt.js";
import { ownedWorkspace } from "../../util/workspace.js";
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

/**
 * Deny rules for `none`. Cursor Agent reads `.cursor/cli.json` from the process cwd, and a deny rule wins over
 * every allow rule, the user's approval mode and `--force`. Grep and glob stay inside the workspace, which is empty.
 */
export const NONE_PERMISSIONS = {
  permissions: { allow: [], deny: ["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)", "Mcp(*:*)"] },
};

/** The empty folder `none` runs in. It holds only the deny rules. */
export function noneWorkspace(): Promise<string> {
  return ownedWorkspace("agent-none", { ".cursor/cli.json": `${JSON.stringify(NONE_PERMISSIONS, null, 2)}\n` });
}

/** Access maps to CLI flags. `accept-edits` has no flag and `supervised` has no approval passthrough, so neither is offered. */
export function accessFlags(access: RunInput["selection"]["access"]): string[] {
  if (access === "full") return ["--force"];
  if (access === "auto") return ["--auto-review"];
  // The deny rules in the workspace do the enforcing. Ask mode only keeps the model from trying.
  if (access === "none") return ["--mode", "ask"];
  throw new FunnelError(`Cursor Agent cannot enforce access "${access}". Supported: none, auto, full.`, "invalid-selection");
}

/** The prompt agent reads from stdin, with the system prompt and schema request folded in. */
export const buildPrompt = (input: RunInput) => composePrompt(input, { system: true, schema: true });

/** `workspace` is the selection's folder, or the `none` workspace. The prompt goes on stdin, so its size has no argv limit. */
export function buildArgs(input: RunInput, model: string, workspace = input.selection.cwd): string[] {
  const { selection } = input;
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--model",
    model,
    "--workspace",
    workspace,
    "--trust",
    ...accessFlags(selection.access),
    ...(input.sessionId ? ["--resume", input.sessionId] : []),
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
  const cwd = input.selection.access === "none" ? await noneWorkspace() : input.selection.cwd;
  const args = buildArgs(input, model, cwd);
  // agent reads the prompt from stdin when argv has none.
  const proc = spawnStream(path, args, { cwd, env: input.env, signal: input.signal, input: buildPrompt(input) });
  const mapper = new StreamMapper();
  let finished = false;
  try {
    for await (const line of proc.lines) {
      for (const event of mapper.map(line)) {
        if (event.type === "done" || event.type === "error") finished = true;
        yield event;
      }
    }
  } finally {
    // Runs too when the caller stops reading early. The CLI must not keep working unattended.
    if (proc.child.exitCode === null) proc.child.kill("SIGTERM");
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
  capabilities: {
    access: ["none", "auto", "full"],
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
