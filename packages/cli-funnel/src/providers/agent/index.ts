import { existsSync } from "node:fs";
import { manifestModels } from "../../catalog/manifest.js";
import { exec, spawnStream } from "../../util/process.js";
import { detectInstallation, exitedEarly, findBinary, runLogout, runUpdate, spawnLogin } from "../base.js";
import { FunnelError, type AuthStatus, type FunnelEvent, type ModelInfo, type Provider, type ProviderContext, type RunInput } from "../../types.js";
import { requireMachine } from "../../selection.js";
import { composePrompt } from "../prompt.js";
import { dirList, flag, mcpServersFor, oneOf, optionsFor, requireAccess } from "../options.js";
import { redactErrors } from "../../util/redact.js";
import { ownedWorkspace } from "../../util/workspace.js";
import { attachMcp } from "./mcp.js";
import { groupModels, parseModelList, parseStatus, StreamMapper, toCliModel } from "./parser.js";

const BINARY = "agent";
const TESTED_RANGE = { min: "2026.09.01" };

let known: Set<string> | undefined;

async function listModels(env?: Record<string, string>): Promise<{ id: string; name: string }[]> {
  const path = findBinary(BINARY);
  if (!path) return [];
  const res = await exec(path, ["--list-models"], { timeoutMs: 30_000, env }).catch(() => undefined);
  return res ? parseModelList(res.stdout) : [];
}

/** The ids the account lists. A run on an API key asks with that key, because its models can differ, and keeps no cache. */
async function knownIds(withKey?: Record<string, string>): Promise<Set<string>> {
  if (withKey) return new Set((await listModels(withKey)).map((m) => m.id));
  if (!known?.size) known = new Set((await listModels()).map((m) => m.id));
  return known;
}

/**
 * The environment for a run on `RunInput.apiKey`. With a key, the CLI signs in and saves the new tokens over the saved
 * login, so the credential store is switched to memory: the saved login is neither read nor written, and a key the
 * CLI rejects fails the run instead of falling back to the account. `CURSOR_API_KEY` keeps the key out of argv.
 */
const MEMORY_STORE = { AGENT_CLI_CREDENTIAL_STORE: "memory" };
const keyEnv = (apiKey: string) => ({ ...MEMORY_STORE, CURSOR_API_KEY: apiKey });

let storeIsolated: Promise<void> | undefined;

/**
 * `AGENT_CLI_CREDENTIAL_STORE` is not in `--help`. If a CLI update drops it, a key would overwrite the saved login, so
 * the run checks first that the memory store hides the saved login, once per process.
 */
function requireIsolatedStore(path: string): Promise<void> {
  storeIsolated ??= exec(path, ["status", "--format", "json"], { timeoutMs: 15_000, env: MEMORY_STORE })
    .then((res) => {
      // Only a clear "not authenticated" answer passes. Empty or unreadable output proves nothing.
      if (!/"isAuthenticated"\s*:\s*false/.test(res.stdout)) throw new Error("agent status did not report a logged-out store");
    })
    .catch((e) => {
      storeIsolated = undefined;
      throw new FunnelError(
        `Cursor Agent would save the API key over the saved login (${e instanceof Error ? e.message : String(e)}). Update cli-funnel for this agent version.`,
        "unsupported",
      );
    });
  return storeIsolated;
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

/** Flags for `providerOptions.agent`. Throws `invalid-selection` when an option would widen `selection.access`. */
function optionArgs(input: RunInput): string[] {
  const o = optionsFor(input, "agent", ["addDirs", "sandbox", "mode"]);
  const { access } = requireMachine(input.selection);
  const args: string[] = [];
  const dirs = dirList(o.addDirs, "addDirs");
  if (dirs) {
    // At `none` the run happens in an empty folder on purpose. Another root would undo that.
    requireAccess(access, ["auto", "full"], "addDirs");
    for (const d of dirs) args.push(flag("--add-dir", d));
  }
  const sandbox = oneOf(o.sandbox, "sandbox", ["enabled", "disabled"] as const);
  if (sandbox === "disabled") requireAccess(access, ["full"], 'sandbox "disabled"');
  if (sandbox) args.push(flag("--sandbox", sandbox));
  if (oneOf(o.mode, "mode", ["plan"] as const)) {
    // Not tested: whether plan mode can write its plan outside the empty `none` folder. `none` keeps ask mode.
    requireAccess(access, ["auto", "full"], 'mode "plan"');
    args.push("--mode", "plan");
  }
  return args;
}

/**
 * `workspace` is the selection's folder, or the `none` workspace. `pluginDirs` carry the run's MCP servers. The prompt
 * goes on stdin, so its size has no argv limit.
 */
export function buildArgs(input: RunInput, model: string, workspace = requireMachine(input.selection).cwd, pluginDirs: string[] = []): string[] {
  const extra = optionArgs(input);
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
    ...accessFlags(requireMachine(input.selection).access),
    ...(input.sessionId ? ["--resume", input.sessionId] : []),
    ...pluginDirs.flatMap((d) => ["--plugin-dir", d]),
    ...extra,
  ];
}

async function authStatus(): Promise<AuthStatus> {
  const path = findBinary(BINARY);
  if (!path) return { loggedIn: false, detail: "agent is not installed." };
  const status = await exec(path, ["status", "--format", "json"], { timeoutMs: 15_000 }).catch(() => undefined);
  if (!status) return { loggedIn: false };
  const text = status.stdout || status.stderr;
  if (!parseStatus(text).loggedIn) return { loggedIn: false };
  const about = await exec(path, ["about", "--format", "json"], { timeoutMs: 15_000 }).catch(() => undefined);
  return parseStatus(text, about?.stdout);
}

async function* run(input: RunInput): AsyncGenerator<FunnelEvent> {
  const path = findBinary(BINARY);
  if (!path) throw new FunnelError("agent is not installed.", "not-installed");
  const servers = mcpServersFor(input, ["http", "stdio"], "Cursor Agent");
  const apiKey = input.apiKey;
  if (apiKey) await requireIsolatedStore(path);
  const model = toCliModel(input.selection, await knownIds(apiKey ? keyEnv(apiKey) : undefined));
  const cwd = input.selection.access === "none" ? await noneWorkspace() : input.selection.cwd;
  const mcp = servers.length ? await attachMcp(servers) : undefined;
  const args = buildArgs(input, model, cwd, mcp ? [mcp.dir] : []);
  const env = { ...input.env, ...mcp?.env, ...(apiKey ? keyEnv(apiKey) : {}) };
  // agent reads the prompt from stdin when argv has none.
  const proc = spawnStream(path, args, { cwd, env, signal: input.signal, input: buildPrompt(input) });
  const mapper = new StreamMapper({ exists: existsSync });
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
    proc.kill();
  }
  if (!finished) yield await exitedEarly(proc, "agent", () => input.signal?.aborted);
}

/** `run` with the key and the header values cut out of error text. */
function runRedacted(input: RunInput): AsyncGenerator<FunnelEvent> {
  const headers = Object.values(input.mcpServers ?? {}).flatMap((m) => (m.type === "http" ? Object.values(m.headers ?? {}) : []));
  return redactErrors(run(input), [input.apiKey, ...headers]);
}

export const agentProvider: Provider = {
  id: "agent",
  displayName: "Cursor Agent",
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
    apiKey: true,
    mcpServers: ["http", "stdio"],
    plan: true,
    fileChanges: true,
  },
  detect: () => detectInstallation(BINARY, TESTED_RANGE),
  authStatus,
  login: (options) =>
    spawnLogin(BINARY, ["login"], authStatus, {
      signal: options?.signal,
      env: process.env.CLI_FUNNEL_OPEN_BROWSER === "1" ? {} : { NO_OPEN_BROWSER: "1" },
      opensBrowser: process.env.CLI_FUNNEL_OPEN_BROWSER === "1",
    }),
  logout: () => runLogout(BINARY, ["logout"]),
  update: () => runUpdate(BINARY, ["update"]),
  async models(ctx?: ProviderContext): Promise<ModelInfo[]> {
    const listed = await listModels();
    if (listed.length) {
      known = new Set(listed.map((m) => m.id));
      return groupModels(listed);
    }
    return manifestModels("agent", ctx?.manifestUrl);
  },
  run: runRedacted,
};
