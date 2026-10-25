import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { manifestModels, mergeModels } from "../../catalog/manifest.js";
import { Channel } from "../../util/channel.js";
import { needsArgFile, writeArgFile } from "../../util/argfile.js";
import { exec, spawnStream } from "../../util/process.js";
import {
  FunnelError,
  type AuthStatus,
  type FunnelEvent,
  type LoginEvent,
  type LoginSession,
  type McpServer,
  type ModelInfo,
  type Provider,
  type ProviderContext,
  type RunInput,
  type Selection,
} from "../../types.js";
import { detectInstallation, exitedEarly, findBinary, LOGIN_TIMEOUT_MS, runUpdate } from "../base.js";
import { createMapper, parseModels } from "./parser.js";
import { composePrompt } from "../prompt.js";
import { dirList, flag, mcpServersFor, optionsFor, positive, requireAccess } from "../options.js";
import { requireMachine } from "../../selection.js";
import { ownedWorkspace } from "../../util/workspace.js";

const TESTED = { min: "1.2.0" };

/** Builds the `--model` / `--effort` pair. Base ids with effort variants need `--effort`. */
export function toCliModel(selection: Selection, models: ModelInfo[] = []): { model: string; effort?: string } {
  const info = models.find((m) => m.id === selection.model);
  const effort = selection.effort ?? (info?.efforts.length ? info.defaultEffort : undefined);
  return { model: selection.model, effort };
}

/** Linux refuses a single argument over 128 KiB. Longer prompts go on stdin. */
const MAX_ARG_PROMPT = 100_000;

/** Windows limits the whole command line to 32,767 characters, so the prompt moves to stdin much sooner there. */
const MAX_ARG_PROMPT_WIN32 = 30_000;

/** Where the prompt goes: `--print=<prompt>` when it fits in argv, else one stdin line in the shape agy 1.x decodes. */
function placePrompt(input: RunInput, platform: NodeJS.Platform): { print: string[]; stdin?: string } {
  const prompt = composePrompt(input, { system: true, schema: false });
  if (Buffer.byteLength(prompt) <= (platform === "win32" ? MAX_ARG_PROMPT_WIN32 : MAX_ARG_PROMPT)) return { print: [`--print=${prompt}`] };
  // An empty --print with stream-json input reads one turn per stdin line.
  return { print: ["--print=", "--input-format", "stream-json"], stdin: `${JSON.stringify({ event: "user", message: { content: prompt } })}\n` };
}

/** The stdin line for a long prompt, or undefined when it fits in argv. */
export function stdinPrompt(input: RunInput, platform: NodeJS.Platform = process.platform): string | undefined {
  return placePrompt(input, platform).stdin;
}

/**
 * `schemaArg` is the `--json-schema` value: a file path for a long schema, or the schema as inline JSON, the default.
 * `placed` is the prompt from `placePrompt`. `mcpDir` is the folder from `mcpWorkspace`, added to the workspace.
 */
export function buildArgs(
  input: RunInput,
  models: ModelInfo[] = [],
  platform: NodeJS.Platform = process.platform,
  schemaArg?: string,
  placed = placePrompt(input, platform),
  mcpDir?: string,
): string[] {
  const { selection } = input;
  const { model, effort } = toCliModel(selection, models);
  const args = [...placed.print, "--output-format", "stream-json", "--model", model];
  if (input.responseSchema) args.push("--json-schema", schemaArg ?? JSON.stringify(input.responseSchema.schema));
  if (effort) args.push("--effort", effort);
  if (selection.access === "accept-edits") args.push("--mode", "accept-edits");
  if (selection.access === "full") args.push("--dangerously-skip-permissions");
  if (input.sessionId) args.push("--conversation", input.sessionId);
  args.push(...optionArgs(input));
  if (mcpDir) args.push(flag("--add-dir", mcpDir));
  return args;
}

/** Flags for `providerOptions.antigravity`. Throws `invalid-selection` when an option would widen `selection.access`. */
function optionArgs(input: RunInput): string[] {
  const o = optionsFor(input, "antigravity", ["addDirs", "printTimeoutSec"]);
  const args: string[] = [];
  const dirs = dirList(o.addDirs, "addDirs");
  if (dirs) {
    // At `none` the run happens in a folder that holds only the deny hook. Another directory would undo that.
    requireAccess(requireMachine(input.selection).access, ["accept-edits", "full"], "addDirs");
    for (const d of dirs) args.push(flag("--add-dir", d));
  }
  const timeout = positive(o.printTimeoutSec, "printTimeoutSec");
  if (timeout !== undefined) args.push(flag("--print-timeout", `${timeout}s`));
  return args;
}

const DENY = { decision: "deny", reason: "Tools are disabled. Answer in text only." };

/**
 * Matches every tool name except `finish`, which ends the turn and carries the `--json-schema` answer.
 * Go regexp has no lookahead, so the exclusion is spelled out.
 */
export const NONE_MATCHER = "^(?:[^f].*|f[^i].*|fi[^n].*|fin[^i].*|fini[^s].*|finis[^h].*|finish.+|.{0,5})$";

/**
 * Hook file for `none`. agy loads `.agents/hooks.json` from the cwd, and a `deny` from a PreToolUse hook blocks the
 * call before any permission check. Allow decisions from other hooks do not override it, and a failing hook also blocks.
 */
export function noneHooks(platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  const json = JSON.stringify(DENY);
  // The hook runs through `sh -c`, or `cmd /c` on Windows. It drains stdin so agy never writes to a closed pipe.
  const command = platform === "win32" ? `echo ${json}` : `cat >/dev/null; printf '%s\\n' '${json}'`;
  return { "cli-funnel-none": { PreToolUse: [{ matcher: NONE_MATCHER, hooks: [{ type: "command", command, timeout: 10 }] }] } };
}

/** The empty folder `none` runs in. It holds only the deny hook. */
export function noneWorkspace(): Promise<string> {
  return ownedWorkspace("antigravity-none", { ".agents/hooks.json": `${JSON.stringify(noneHooks(), null, 2)}\n` });
}

/**
 * The plugin that carries the caller's MCP servers. agy has no flag or env var for MCP servers, but it loads plugins from
 * `.agents/plugins/` in every workspace folder, and `--add-dir` makes a folder one. A plugin's servers show up to the model
 * as `<plugin>_<server>`, so the model sees `funnel_<name>`.
 */
export const MCP_PLUGIN = "funnel";

/**
 * The plugin's `mcp_config.json`. HTTP servers are a `url` with `headers`, stdio servers a `command` with `args` and `env`.
 * `autoApprove` has no counterpart: agy never asks, it either allows a tool call (`full`) or denies it.
 */
export function mcpConfig(servers: [string, McpServer][]): { mcpServers: Record<string, Record<string, unknown>> } {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const [name, s] of servers) {
    const timeout = s.toolTimeoutSec ? { timeoutSeconds: Math.ceil(s.toolTimeoutSec) } : {};
    mcpServers[name] =
      s.type === "http"
        ? { url: s.url, ...(s.headers && { headers: s.headers }), ...timeout }
        : { command: s.command, ...(s.args && { args: s.args }), ...(s.env && { env: s.env }), ...timeout };
  }
  return { mcpServers };
}

/**
 * A private folder for one run that holds the MCP plugin. It never touches the user's project or agy config. The
 * headers may carry a token, so the folder is mode 0700 and `remove` deletes it after the run.
 */
async function mcpWorkspace(servers: [string, McpServer][]): Promise<{ dir: string; remove(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cli-funnel-agy-mcp-"));
  try {
    const plugin = join(dir, ".agents", "plugins", MCP_PLUGIN);
    await mkdir(plugin, { recursive: true, mode: 0o700 });
    await writeFile(join(plugin, "plugin.json"), `${JSON.stringify({ name: MCP_PLUGIN })}\n`, { mode: 0o600 });
    await writeFile(join(plugin, "mcp_config.json"), `${JSON.stringify(mcpConfig(servers), null, 2)}\n`, { mode: 0o600 });
    return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Task lists are a few KB. A bigger file is not one, and the cap keeps a model-chosen path from making us read a huge file. */
const MAX_TASK_LIST = 256 * 1024;

function readTaskList(path: string): string | undefined {
  try {
    return statSync(path).size <= MAX_TASK_LIST ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** Clock and file system timestamps can differ by this much. */
const CLOCK_SLACK_MS = 1000;

/**
 * For `MapperOptions.createdInRun`: whether the file was created at or after `startedAt`, by its creation time.
 * Undefined when the file is gone or the file system reports no creation time (some Linux setups give 0).
 */
export function createdSince(startedAt: number): (path: string) => boolean | undefined {
  return (path) => {
    try {
      const born = statSync(path).birthtimeMs;
      return born > 0 ? born >= startedAt - CLOCK_SLACK_MS : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Where agy keeps its settings and conversations, under a home folder. */
const dataDir = (home: string) => join(home, ".gemini", "antigravity-cli");

/**
 * agy runs on `GEMINI_API_KEY` only when `settings.json` says `"modelProvider": "gemini"`, and it reads that file from
 * the home folder. So an API-key run gets its own home folder with that one setting, and the user's settings and
 * sign-in stay as they are. Conversations of these runs live in that folder too, so they resume only in API-key runs.
 */
export function apiKeyHome(): Promise<string> {
  return ownedWorkspace("antigravity-api-key", { ".gemini/antigravity-cli/settings.json": `${JSON.stringify({ modelProvider: "gemini" })}\n` });
}

/** The environment of an API-key run: the key, and the folder from `apiKeyHome` as the home folder. */
export function apiKeyEnv(apiKey: string, home: string, env: Record<string, string> | undefined): Record<string, string> {
  return { ...env, GEMINI_API_KEY: apiKey, HOME: home, USERPROFILE: home };
}

/** True when the user has told agy to run on a Gemini API key: the setting is on and the key is in the environment. */
function usesGeminiKey(): boolean {
  if (!process.env.GEMINI_API_KEY) return false;
  try {
    return JSON.parse(readFileSync(join(dataDir(homedir()), "settings.json"), "utf8")).modelProvider === "gemini";
  } catch {
    return false;
  }
}

/**
 * The last list `models()` returned: `agy models` merged with the manifest, from `manifestUrl` when one is set. The
 * funnel lists models before every run, so a run picks its default effort from the same list the user picked from.
 */
let listed: ModelInfo[] | undefined;

/** How often `login()` asks `agy models` whether the user has signed in. */
const LOGIN_POLL_MS = 3000;

/**
 * agy keeps its OAuth token in the OS keyring (macOS Keychain, Windows Credential Manager, Secret Service) and writes
 * a token file only when the keyring is unavailable. A missing file therefore says nothing about sign-in, so the only
 * reliable check is to ask agy. `agy models` exits 0 with a model list when signed in and exits 1 with a sign-in
 * message when not.
 */
async function checkAuth(): Promise<AuthStatus> {
  const path = findBinary("agy");
  if (!path) return { loggedIn: false, detail: "agy is not installed." };
  const res = await exec(path, ["models"], { timeoutMs: 20_000 }).catch((e: unknown) => e as Error);
  if (res instanceof Error) return { loggedIn: false, detail: `agy could not run: ${res.message}` };
  if (res.code === 0 && parseModels(res.stdout).length > 0) {
    return { loggedIn: true, method: usesGeminiKey() ? "Gemini API key" : "Google account" };
  }
  const output = (res.stderr + res.stdout).trim();
  if (res.code !== null && /sign in/i.test(output)) return { loggedIn: false, detail: "Run agy in a terminal and sign in." };
  // A timeout (code null), a crash or an empty list: agy did not answer, which is not the same as signed out.
  const last = output.split("\n").at(-1) ?? "";
  const why = res.code === null ? "agy did not answer in time" : res.code === 0 ? "agy listed no models" : `agy exited with code ${res.code}`;
  return { loggedIn: false, detail: `${why}.${last ? ` ${last}` : ""}` };
}

let pending: Promise<AuthStatus> | undefined;

/** One `agy models` at a time: callers that arrive while a check runs share its result. */
function authStatus(): Promise<AuthStatus> {
  pending ??= checkAuth().finally(() => (pending = undefined));
  return pending;
}

function login(options: { signal?: AbortSignal } = {}): LoginSession {
  const channel = new Channel<LoginEvent>();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    channel.end();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  channel.push({ type: "needs-terminal", command: ["agy"] });
  void (async () => {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (!cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, LOGIN_POLL_MS));
      if (cancelled) return;
      const status = await authStatus();
      if (status.loggedIn) {
        channel.push({ type: "done", status });
        return channel.end();
      }
    }
    if (!cancelled) channel.push({ type: "error", message: "Timed out waiting for sign-in." });
    channel.end();
  })();
  return { [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](), sendCode: () => {}, cancel };
}

async function* run(input: RunInput): AsyncGenerator<FunnelEvent> {
  const path = findBinary("agy");
  if (!path) throw new FunnelError("agy is not installed.", "not-installed");
  const models = listed?.some((m) => m.id === input.selection.model) ? listed : await manifestModels("antigravity");
  const servers = mcpServersFor(input, ["http", "stdio"], "Antigravity");
  // At accept-edits agy denies every MCP tool call, because headless mode cannot ask. Attaching servers there would only fail.
  if (servers.length) requireAccess(requireMachine(input.selection).access, ["full"], "Antigravity MCP servers");
  const cwd = input.selection.access === "none" ? await noneWorkspace() : input.selection.cwd;
  const home = input.apiKey ? await apiKeyHome() : undefined;
  const mcp = servers.length ? await mcpWorkspace(servers) : undefined;
  // A long schema would count against the command-line limit, so it goes through a private temp file removed after the run.
  const schema = input.responseSchema ? JSON.stringify(input.responseSchema.schema) : undefined;
  let schemaFile: Awaited<ReturnType<typeof writeArgFile>> | undefined;
  const cleanup = async () => {
    await schemaFile?.remove();
    await mcp?.remove();
  };
  let stream: ReturnType<typeof spawnStream>;
  const startedAt = Date.now();
  try {
    schemaFile =schema && needsArgFile(schema) ? await writeArgFile("schema.json", schema) : undefined;
    const placed = placePrompt(input, process.platform);
    stream = spawnStream(path, buildArgs(input, models, process.platform, schemaFile?.path ?? schema, placed, mcp?.dir), {
      cwd,
      env: home && input.apiKey ? apiKeyEnv(input.apiKey, home, input.env) : input.env,
      signal: input.signal,
      input: placed.stdin ?? "",
    });
  } catch (err) {
    await cleanup();
    throw err;
  }
  const mapper = createMapper({
    auth: home ? "api-key" : undefined,
    createdInRun: createdSince(startedAt),
    brainDir: join(dataDir(home ?? homedir()), "brain"),
    readText: readTaskList,
  });
  try {
    for await (const line of stream.lines) {
      for (const e of mapper.map(line)) yield e;
    }
  } finally {
    // Runs too when the caller stops reading early. The CLI must not keep working unattended.
    stream.kill();
    await cleanup();
  }
  if (!mapper.finished) yield await exitedEarly(stream, "agy", () => input.signal?.aborted);
}

export const antigravityProvider: Provider = {
  id: "antigravity",
  displayName: "Antigravity",
  capabilities: {
    access: ["none", "accept-edits", "full"],
    effort: true,
    contextWindow: false,
    fast: false,
    resume: true,
    approvals: false,
    images: false,
    system: "prompt",
    schema: "native",
    mcpServers: ["http", "stdio"],
    apiKey: true,
    plan: true,
    fileChanges: true,
  },
  detect: () => detectInstallation("agy", TESTED),
  authStatus,
  login,
  async logout() {
    throw new FunnelError(
      "agy has no sign-out command. Run agy and open its account menu to sign out.",
      "unsupported",
    );
  },
  update: () => runUpdate("agy", ["update"]),
  async models(ctx?: ProviderContext) {
    const fallback = await manifestModels("antigravity", ctx?.manifestUrl);
    const path = findBinary("agy");
    if (!path) return fallback;
    const res = await exec(path, ["models"], { timeoutMs: 20_000 }).catch(() => undefined);
    const live = res && res.code === 0 ? parseModels(res.stdout) : [];
    listed = live.length ? mergeModels(live, fallback) : fallback;
    return listed;
  },
  run,
};
