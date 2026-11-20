import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { manifestModels, mergeModels } from "../../catalog/manifest.js";
import { Channel } from "../../util/channel.js";
import { needsArgFile, writeArgFile } from "../../util/argfile.js";
import { exec, spawnStream } from "../../util/process.js";
import {
  FunnelError,
  type AuthStatus,
  type FunnelEvent,
  type LiveSession,
  type LoginEvent,
  type LoginSession,
  type McpServer,
  type ModelInfo,
  type Provider,
  type ProcessOptions,
  type ProviderContext,
  type RateLimits,
  type RunInput,
  type Selection,
} from "../../types.js";
import { compareVersions } from "../../util/process.js";
import { detectInstallation, exitedEarly, findBinary, isTerminal, LOGIN_TIMEOUT_MS, rawTap, runUpdate, SETTLE_MS, stderrTail } from "../base.js";
import { redactErrors, runSecrets } from "../../util/redact.js";
import { createMapper, parseModels, parseRateLimits, parseWarning } from "./parser.js";
import { openAcpSession, type AcpSetup } from "./acp/session.js";
import { ACP_MIN_VERSION, checkAcpServers, reserveServers } from "./acp/protocol.js";
import { SubagentTranscripts, type ForwardSubagents } from "./transcript.js";
import { composePrompt } from "../prompt.js";
import { createNoneGuard } from "../none-guard.js";
import { AGY_REFUSAL, DENY_REASON, DENY_REASON_WITH_MCP } from "./deny.js";
import { FEEDBACK_CHANNELS } from "../feedback.js";
import { bool, dirList, flag, mcpServersFor, oneOf, optionsFor, positive, requireAccess } from "../options.js";
import { requireMachine } from "../../selection.js";
import { NO_GIT_ENV, ownedWorkspace, workspaceFor, workspacePath } from "../../util/workspace.js";

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

/** The values of `providerOptions.antigravity`, checked. Throws `invalid-selection` when an option would widen `selection.access`. */
function checkOptions(input: RunInput) {
  const o = optionsFor(input, "antigravity", ["addDirs", "printTimeoutSec", "forwardSubagentText", "forwardSubagentTools", "transport"]);
  const forwardText = bool(o.forwardSubagentText, "forwardSubagentText");
  const forwardTools = bool(o.forwardSubagentTools, "forwardSubagentTools");
  const dirs = dirList(o.addDirs, "addDirs");
  if (dirs) {
    // At `none` the run happens in a folder that holds only the deny hook. Another directory would undo that.
    requireAccess(requireMachine(input.selection).access, ["accept-edits", "full"], "addDirs");
  }
  const timeout = positive(o.printTimeoutSec, "printTimeoutSec");
  const transport = oneOf(o.transport, "transport", ["acp", "print"] as const) ?? (input.apiKey ? "print" : "acp");
  return { dirs, timeout, transport, forward: Boolean(forwardText || forwardTools) };
}

/** Flags for the print transport from `providerOptions.antigravity`. */
function optionArgs(input: RunInput): string[] {
  const { dirs, timeout } = checkOptions(input);
  const args: string[] = [];
  for (const d of dirs ?? []) args.push(flag("--add-dir", d));
  if (timeout !== undefined) args.push(flag("--print-timeout", `${timeout}s`));
  return args;
}

const DENY = { decision: "deny", reason: DENY_REASON };

/**
 * Matches every tool name except `finish`, which ends the turn and carries the `--json-schema` answer.
 * Go regexp has no lookahead, so the exclusion is spelled out.
 */
export const NONE_MATCHER = "(?s)^(?:[^f].*|f[^i].*|fi[^n].*|fin[^i].*|fini[^s].*|finis[^h].*|finish.+|.{0,5})$";

/**
 * A regular expression that matches every string except `names`, and every string that starts with one of `prefixes`
 * left out as well. Go regexp has no lookahead, so the complement is spelled out as a trie: at each step a character that
 * continues no name matches the rest, a character that continues a name goes on with that name, and a string that ends
 * early or runs past a whole name matches. `NONE_MATCHER` is this for `finish`. This is what a hook matcher can say: it
 * tests the tool's name and nothing in its arguments.
 */
export function exceptNames(names: readonly string[], prefixes: readonly string[] = []): string {
  type Node = { children: Map<string, Node>; end: boolean; prefix: boolean };
  const root: Node = { children: new Map(), end: false, prefix: false };
  const add = (word: string, flag: "end" | "prefix") => {
    let node = root;
    for (const ch of word) {
      if (!node.children.has(ch)) node.children.set(ch, { children: new Map(), end: false, prefix: false });
      node = node.children.get(ch)!;
    }
    node[flag] = true;
  };
  for (const name of names) add(name, "end");
  for (const prefix of prefixes) add(prefix, "prefix");
  const esc = (c: string) => c.replace(/[\\^$.|?*+()[\]{}-]/g, "\\$&");
  const alternatives = (node: Node): string[] => {
    // Everything from here on starts with an excluded prefix.
    if (node.prefix) return [];
    const chars = [...node.children.keys()].map(esc).join("");
    const out = [chars ? `[^${chars}].*` : ".+"];
    for (const [ch, child] of node.children) out.push(...alternatives(child).map((a) => esc(ch) + a));
    // A string that ends here is a proper prefix of a name, or is empty, and is not a name. One that runs on is longer.
    if (node.end) out.push(".+");
    else out.push("");
    return out;
  };
  // `(?s)` lets `.` match a line break, so a name with one in it is still refused.
  return `(?s)^(?:${alternatives(root).join("|")})$`;
}

const DENY_WITH_MCP = { decision: "deny", reason: DENY_REASON_WITH_MCP };

/** The tool names that start with a run's prefix are the run's own servers' tools. */
export const mcpPrefix = (run: string): string => `mcp_clifunnel${run}_`;

/**
 * The command of a deny hook: it drains stdin so agy never writes to a closed pipe, then prints the deny answer. It runs
 * through `sh -c`, or `cmd /c` on Windows, and needs nothing but those, no Node and no copy of the host app.
 */
export function denyCommand(platform: NodeJS.Platform, answer: object = DENY): string {
  const json = JSON.stringify(answer);
  return platform === "win32" ? `echo ${json}` : `cat >/dev/null; printf '%s\\n' '${json}'`;
}

/**
 * Hook file for `none`. agy loads `.agents/hooks.json` from the cwd, and a `deny` from a PreToolUse hook blocks the call
 * before any permission check. Allow decisions from other hooks do not override it, and a failing hook also blocks. The
 * matcher decides which calls reach the hook: every tool name but `finish`, which ends the turn and carries the
 * `--json-schema` answer, and, for a run with MCP servers, the names that start with this run's prefix, so the hook is a
 * fixed deny and needs no script. `call_mcp_tool` is not left out: it names its server in its arguments, which a matcher
 * cannot see, so the model reaches the run's servers by the tool names agy gives them.
 */
export function noneHooks(platform: NodeJS.Platform = process.platform, run?: string): Record<string, unknown> {
  const matcher = run === undefined ? NONE_MATCHER : exceptNames(["finish"], [mcpPrefix(run)]);
  const command = denyCommand(platform, run === undefined ? DENY : DENY_WITH_MCP);
  return { "cli-funnel-none": { PreToolUse: [{ matcher, hooks: [{ type: "command", command, timeout: 10 }] }] } };
}

/**
 * Runs a hook command once, the way agy will, with a call that must be refused on stdin, and answers whether it printed the
 * deny answer. agy reads a hook that exits 0 and prints nothing as "allow", so a command that starts something else, or
 * does nothing, would leave every tool open. Nothing is trusted that this has not seen work.
 */
export async function hookDenies(command: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const call = JSON.stringify({ hookEventName: "PreToolUse", toolCall: { id: "self-test", name: "run_command", args: { CommandLine: "true" } } });
  const [file, args] = platform === "win32" ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`]] : ["sh", ["-c", command]];
  const res = await exec(file, args, { input: call, timeoutMs: 10_000, verbatim: platform === "win32" }).catch(() => undefined);
  if (!res || res.code !== 0) return false;
  try {
    return JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "").decision === "deny";
  } catch {
    return false;
  }
}

/** The commands already shown to deny, so a process checks each once. */
const verified = new Map<string, Promise<boolean>>();

/** Forgets which hook commands were shown to deny, so the next run checks again. For tests. */
export const forgetVerifiedHooks = (): void => verified.clear();

/** Fails the run with `unsupported` unless the hook of a `none` run, as agy will run it, prints the deny answer. */
export async function requireWorkingHook(run?: string): Promise<void> {
  const hooks = noneHooks(process.platform, run) as { "cli-funnel-none": { PreToolUse: { hooks: { command: string }[] }[] } };
  const command = hooks["cli-funnel-none"].PreToolUse[0]!.hooks[0]!.command;
  let ok = verified.get(command);
  if (!ok) verified.set(command, (ok = hookDenies(command)));
  if (!(await ok)) {
    verified.delete(command);
    throw new FunnelError("The deny hook that keeps tools off at access none does not print its answer when run through the shell, so agy would read it as allow. The run was not started.", "unsupported");
  }
}

/**
 * What makes a folder a git repository for `git rev-parse`: a `HEAD`, an `objects` folder and a `refs` folder. agy looks for
 * the repository root and loads `AGENTS.md`, `GEMINI.md` and `.agents/` from every folder between the working folder and
 * that root, so a `none` folder inside a user's repository, or under a home folder that is one, would read the user's
 * instructions. With its own root it reads nothing above itself. An empty `.git` folder is not enough: agy walked past it.
 * Cursor Agent does not stop at it: see `docs/providers/agent.md`.
 */
export const GIT_MARKER: Record<string, string> = { ".git/HEAD": "ref: refs/heads/main\n", ".git/objects/": "", ".git/refs/": "" };

/**
 * The empty folder `none` runs in. It holds only the deny hook and the marker that makes it the root of its own
 * repository. A run with MCP servers has a folder of its own, `.run.<id>`, since its hook names the run's random prefix.
 * Every suffix starts with a dot, which a caller's name cannot hold, so no name gives one run the folder of another.
 */
export function noneWorkspace(caller?: string, run?: string): Promise<string> {
  const name = workspaceFor("antigravity-none", caller) + (run === undefined ? "" : `.run.${run}`);
  return ownedWorkspace(name, { ...GIT_MARKER, ".agents/hooks.json": `${JSON.stringify(noneHooks(process.platform, run), null, 2)}\n` });
}

/** Removes the folder of a run with MCP servers once the run is over. */
export const removeRunWorkspace = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });

/**
 * Refuses the caller's MCP servers at `none` on Windows. They are the only tools the model may use there, and the hook
 * that refuses every other one is a shell command run through `cmd.exe`, which has not been shown to deny on Windows. A
 * tool that gets past it would be a tool the caller did not list. Lift this once a live run on Windows shows the deny.
 */
export function requireMcpAtNoneHere(servers: readonly unknown[], platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32" && servers.length) {
    throw new FunnelError('Antigravity takes MCP servers at access "none" only off Windows. The hook that keeps every other tool off has not been shown to deny there. Use another access level, or leave the servers out.', "unsupported");
  }
}

/**
 * Removes the folders of runs that ended without cleaning up, such as a host that exited before agy did. Only folders
 * named like a run's, and only those not touched for `maxAgeMs`, a day by default: a kept-alive session may hold its own
 * for hours. Failures are ignored, since this is housekeeping.
 */
export async function sweepRunWorkspaces(maxAgeMs = 24 * 3_600_000): Promise<void> {
  const root = dirname(workspacePath("x"));
  const names = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((n) => /^antigravity-none(\.[a-z0-9_-]+)?\.run\.[0-9a-f]{8}$/.test(n))
      .map(async (n) => {
        const info = await stat(join(root, n)).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > maxAgeMs) await rm(join(root, n), { recursive: true, force: true }).catch(() => undefined);
      }),
  );
}

/**
 * The `--gemini-dir` of a `none` run over ACP. agy reads the user's MCP servers (`config/mcp_config.json`), skills and
 * global `GEMINI.md` from the folder it calls its Gemini folder, `~/.gemini` by default, and starts those servers before
 * the first prompt. A folder of our own that holds only a link to the user's `antigravity-cli` data folder has none of
 * them, and agy still finds the sign-in and the conversations through the link. Checked on 1.5.12: a stdio server in the
 * user's config started with the default and did not start with this folder, and the session and its models still came
 * back.
 *
 * The folder is made inert before agy sees it. A first start in a Gemini folder with no `config/.migrated` runs agy's
 * migration, and through the link that moved a user's `antigravity-cli/skills` into the private folder and left a link
 * behind, or re-pointed an existing link at the private folder. So the folder always holds `config/.migrated`, an empty
 * `config/skills` folder and an empty MCP config, and agy has nothing to migrate. Checked in a throwaway home on 1.5.12: with
 * these the user's `skills` came out of a start exactly as it went in, as a folder and as a link to `config/skills`.
 *
 * Nothing is removed recursively here. A link is replaced by `unlink`, an old real data folder in the private folder is
 * moved aside, and the user's data folder is made when there is none, so no conversation is ever kept where a later
 * run would delete it.
 *
 * Calls in one process go one after another: on Windows a junction shows up as an empty folder for a moment while it is
 * made, and a second call that finds it then would try to move it aside. Another process can still meet that moment, so
 * a failed move is forgiven when the link points where ours would.
 */
let linking: Promise<unknown> = Promise.resolve();
export function noneGeminiDir(home: string = homedir()): Promise<string> {
  const made = linking.then(() => makeGeminiDir(home));
  linking = made.catch(() => undefined);
  return made;
}

/** `unlink` that takes it as done when another process got there first (`ENOENT`) and fails on anything else. */
async function unlinkIfThere(path: string): Promise<void> {
  await unlink(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}

/** `noneGeminiDir` without the one-at-a-time queue: what several processes running together do. Exported for the test. */
export async function makeGeminiDir(home: string): Promise<string> {
  const dir = await ownedWorkspace("antigravity-gemini-none", { "config/.migrated": "", "config/mcp_config.json": `${JSON.stringify({ mcpServers: {} })}\n`, "config/skills/": "" });
  // `config/skills` is a link when an earlier agy re-pointed it. Replace the link, never what it points at.
  const skills = join(dir, "config", "skills");
  if ((await lstat(skills).catch(() => undefined))?.isSymbolicLink()) {
    await unlinkIfThere(skills);
    await mkdir(skills, { recursive: true, mode: 0o700 });
  }
  const target = dataDir(home);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const link = join(dir, "antigravity-cli");
  // Other processes fix the same link at the same time. Each pass looks at what is there now, and a step that another
  // process already took (`ENOENT` on a removal, `EEXIST` on the link) sends it round again, as does a path that
  // Windows holds for a moment (`EBUSY`, `EPERM`) while another process removes or makes it. A few passes are enough: a
  // process that removes a link it read before another fixed it only makes the next pass of the others make it again.
  const again = new Set(["ENOENT", "EEXIST", "EBUSY", "EPERM"]);
  let last: unknown;
  for (let pass = 0; pass < 10; pass++) {
    try {
      const info = await lstat(link).catch(() => undefined);
      if (info?.isSymbolicLink()) {
        // By what it resolves to: the home may be reached through a link, and a dangling link resolves to nothing.
        const [now, want] = await Promise.all([realpath(link).catch(() => undefined), realpath(target)]);
        if (now === want) return dir;
        await unlinkIfThere(link);
      } else if (info) {
        // A real data folder left here by an earlier run holds conversations. Move it aside, never delete it.
        await rename(link, `${link}.kept-${Date.now()}`);
        continue;
      }
      // A junction needs no privilege on Windows, where a symbolic link to a folder does.
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      return dir;
    } catch (e) {
      if (!again.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      last = e;
      await new Promise((resolve) => setTimeout(resolve, 5 * (pass + 1)));
    }
  }
  throw last ?? new FunnelError("The link to agy's data folder could not be made: other processes kept changing it.", "cli-failed");
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

/**
 * `MapperOptions.createdInRun` for a run. At `none` there is none, so the file system is never asked about a path the
 * model chose: a run that may not read files must not learn which ones exist. Above `none` agy can read the folder.
 */
export const createdInRunFor = (input: RunInput, startedAt: number): ((path: string) => boolean | undefined) | undefined =>
  input.selection.access === "none" ? undefined : createdSince(startedAt);

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

/** Marks a read of the subagents' transcripts in the run's channel. */
const WAKE = Symbol("transcripts");

/** The subagent work an Antigravity run turns into events, from `providerOptions.antigravity`. */
const antigravityForward = (input: RunInput): ForwardSubagents => ({
  text: input.providerOptions?.antigravity?.forwardSubagentText === true,
  tools: input.providerOptions?.antigravity?.forwardSubagentTools === true,
});

async function* runPrint(input: RunInput): AsyncGenerator<FunnelEvent> {
  const path = findBinary("agy");
  if (!path) throw new FunnelError("agy is not installed.", "not-installed");
  if (input.attachments?.length) throw new FunnelError('Antigravity takes image attachments only over ACP. Use providerOptions.antigravity.transport "acp".', "unsupported");
  const models = listed?.some((m) => m.id === input.selection.model) ? listed : await manifestModels("antigravity");
  const servers = mcpServersFor(input, ["http", "stdio"], "Antigravity", ["http", "stdio"]);
  // At accept-edits agy denies every MCP tool call, because headless mode cannot ask. Attaching servers there would only fail.
  // At none the print transport has no way to let the servers through its deny hook and refuse the rest.
  if (servers.length && input.selection.access === "none") throw new FunnelError('MCP servers at access "none" need the ACP transport.', "unsupported");
  if (servers.length) requireAccess(requireMachine(input.selection).access, ["full"], "Antigravity MCP servers");
  const cwd = input.selection.access === "none" ? await noneWorkspace(input.workspaceName) : input.selection.cwd;
  if (input.selection.access === "none") await requireWorkingHook();
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
      env: runEnv(input, home && input.apiKey ? apiKeyEnv(input.apiKey, home, input.env) : input.env),
      signal: input.signal,
      input: placed.stdin ?? "",
    });
  } catch (err) {
    await cleanup();
    throw err;
  }
  // The run's own brain folder: the API-key home when there is one, else the user's.
  const brainDir = join(dataDir(home ?? homedir()), "brain");
  const mapper = createMapper({
    auth: home ? "api-key" : undefined,
    access: requireMachine(input.selection).access,
    resume: input.sessionId,
    createdInRun: createdInRunFor(input, startedAt),
    brainDir,
    readText: readTaskList,
  });
  const tap = rawTap("antigravity", input, stream);
  // Warnings come on stderr, a pipe of their own, and can arrive before the `init` line. They wait here until the loop
  // has sent `session`, or until the run ends without one.
  const held: string[] = [];
  const stopStderr = stream.onStderr((line) => {
    const message = parseWarning(line);
    if (message) held.push(message);
  }, runSecrets(input));
  const takeWarnings = (): FunnelEvent[] => held.splice(0).map((message) => ({ type: "warning", message }));
  // Stderr may be read a moment after a stdout line that agy wrote later, so the loop waits once before it takes warnings.
  const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  // Stderr is all read once the process has closed. A one-shot agy exits right after `result`; one that lingers is stopped
  // after the grace period. A failed resume is stopped at once, because it would go on working in the new conversation.
  const ended = async (stopNow: boolean) => {
    const timer = setTimeout(() => stream.kill(), stopNow ? 0 : EXIT_GRACE_MS);
    await stream.exited;
    clearTimeout(timer);
  };
  let sessionSent = false;
  let guarded = false;
  const guard = input.selection.access === "none" ? createNoneGuard((start) => start.name !== "finish", AGY_REFUSAL) : undefined;
  const forward = antigravityForward(input);
  // Only with a forward option: the stream lines and the subagents' transcripts then go through one channel.
  let source: AsyncIterable<unknown> = stream.lines;
  let transcripts: SubagentTranscripts | undefined;
  if (forward.text || forward.tools) {
    const merged = new Channel<unknown>();
    transcripts = new SubagentTranscripts(brainDir, forward, input, () => merged.push(WAKE));
    void (async () => {
      try {
        for await (const line of stream.lines) merged.push(line);
        merged.end();
      } catch (err) {
        merged.fail(err);
      }
    })();
    source = merged;
  }
  try {
    for await (const line of source) {
      if (line === WAKE) {
        const found = transcripts!.take();
        if (!mapper.finished) yield* found;
        continue;
      }
      // Nothing goes out after the terminal event.
      const before = mapper.finished;
      let events = mapper.map(line);
      // The deny hook is agy's own. A tool that finishes at `none` means it did not apply, and the run stops.
      // At the end of the run, a forbidden call that never ended may have run too.
      const reason = guard && !before ? events.map((e) => guard.check(e)).find((r) => r !== undefined) ?? (events.some(isTerminal) ? guard.unfinished() : undefined) : undefined;
      if (reason) {
        stream.kill();
        guarded = true;
        events = [{ type: "error", message: reason, code: "cli-failed" }];
      }
      transcripts?.watch(line);
      const terminal = events.some(isTerminal);
      if (tap && !before) {
        if (terminal) yield* await tap.settle();
        yield* tap.events(line);
      }
      // A subagent may still be writing when the run ends, so its transcript is read once more first.
      if (transcripts && terminal && !before) yield* await transcripts.finish();
      // Warnings follow `session` and `access.reduced`. Before the first `session` they wait, unless the run ends here.
      const lastOfStart = events.findLastIndex((e) => e.type === "session" || e.type === "access.reduced");
      if (terminal) await ended(!sessionSent && events.some((e) => e.type === "error") && !!input.sessionId);
      else if (!sessionSent && lastOfStart >= 0) await settle();
      if (!sessionSent && lastOfStart >= 0) {
        sessionSent = true;
        events.splice(lastOfStart + 1, 0, ...takeWarnings());
      } else if (sessionSent || terminal) {
        events.unshift(...takeWarnings());
      }
      yield* events;
      // The terminal event ends the stream, also when the CLI keeps running (a resume that started another conversation).
      if (terminal) break;
    }
    // After the guard's error nothing else goes out: the error is the last event of the run.
    if (tap && !mapper.finished && !guarded) yield* tap.events();
    if (transcripts && !mapper.finished && !guarded) yield* await transcripts.finish();
  } finally {
    transcripts?.stop();
    tap?.close();
    // Runs too when the caller stops reading early. The CLI must not keep working unattended.
    stream.kill();
    // The last unterminated stderr line comes when the process closes, so the listener goes after that.
    void stream.exited.then(stopStderr);
    await cleanup();
  }
  if (!mapper.finished && !guarded) {
    const last = await exitedEarly(stream, "agy", () => input.signal?.aborted);
    yield* takeWarnings();
    yield last;
  }
}

/** The environment of a run. At `none` the variables that point git at another repository are removed, as the folder has a git marker of its own. */
const runEnv = (input: RunInput, env: Record<string, string> | undefined) => (input.selection.access === "none" ? { ...env, ...NO_GIT_ENV } : env);

/** The folder where agy keeps its conversation files and artifacts, for runs on the user's login. */
const brainFolder = () => join(dataDir(homedir()), "brain");

/** What an ACP session needs before its process starts. Throws for an option the transport cannot honour. */
async function acpSetup(input: RunInput): Promise<AcpSetup> {
  const path = findBinary("agy");
  if (!path) throw new FunnelError("agy is not installed.", "not-installed");
  const { dirs, timeout, transport, forward } = checkOptions(input);
  if (transport !== "acp") throw new FunnelError('transport "print" does not open an ACP session.', "invalid-selection");
  if (input.apiKey !== undefined) throw new FunnelError('Antigravity runs on an API key only with transport "print".', "unsupported");
  if (forward) throw new FunnelError('forwardSubagentText and forwardSubagentTools read the print transport\'s output. Use transport "print" for them.', "unsupported");
  const access = requireMachine(input.selection).access;
  const servers = mcpServersFor(input, ["http", "stdio"], "Antigravity", ["http", "stdio"]);
  // At accept-edits agy asks about every MCP call, and nobody can answer there.
  if (servers.length) requireAccess(access, ["none", "full"], "Antigravity MCP servers");
  if (access === "none") requireMcpAtNoneHere(servers);
  checkAcpServers(servers);
  // The names the servers have inside agy carry a random part of this run, so nothing that exists beforehand can share them.
  const run = randomBytes(4).toString("hex");
  const mcp = reserveServers(servers, run);
  // A run at `none` with servers has a folder of its own, removed when the process ends. The hook that runs there is
  // shown to deny before anything starts.
  if (access === "none" && servers.length) await sweepRunWorkspaces();
  const ownsFolder = access === "none" && servers.length > 0;
  const folderRun = ownsFolder ? run : undefined;
  const cwd = access === "none" ? await noneWorkspace(input.workspaceName, folderRun) : input.selection.cwd!;
  // Up to the moment agy starts, a failure takes the run's own folder with it.
  let args: string[];
  try {
    if (access === "none") await requireWorkingHook(folderRun);
    args = [
      ...(dirs ?? []).map((d) => flag("--add-dir", d)),
      ...(access === "full" ? ["--dangerously-skip-permissions"] : []),
      // At `none` the user's own agy setup stays out: see `noneGeminiDir`.
      ...(access === "none" ? [flag("--gemini-dir", await noneGeminiDir())] : []),
    ];
  } catch (err) {
    if (ownsFolder) await removeRunWorkspace(cwd).catch(() => undefined);
    throw err;
  }
  return {
    path,
    cwd,
    args,
    ...(timeout !== undefined ? { timeoutSec: timeout } : {}),
    brainDir: brainFolder(),
    readText: readTaskList,
    createdInRun: (startedAt) => createdInRunFor(input, startedAt),
    defaultEffort: (model) => toCliModel({ ...input.selection, model, effort: undefined }, listed ?? []).effort,
    onModels: (live) => {
      listed = mergeModels(live, listed ?? []);
    },
    mcpServers: mcp.acp,
    mcpCallers: mcp.callers,
    ...(access === "none" && servers.length ? { allowMcp: new Set(mcp.reserved) } : {}),
    // Before every turn at `none`: the folder and the hook in it are put back as they should be, and a folder of a run is
    // marked as in use, so the sweep of another process, which goes by the time of its last change, leaves it alone.
    ...(access === "none"
      ? {
          refresh: async () => {
            await noneWorkspace(input.workspaceName, folderRun);
            if (ownsFolder) await utimes(cwd, new Date(), new Date());
          },
        }
      : {}),
    cleanup: async () => {
      if (ownsFolder) await removeRunWorkspace(cwd);
    },
  };
}

const transportOf = (input: RunInput) => checkOptions(input).transport;

/** Opens the session. When that fails, the run's own folder goes with it, since nothing else would remove it. */
async function openAcp(input: RunInput): Promise<LiveSession> {
  const setup = await acpSetup(input);
  try {
    return await openAcpSession(input, setup);
  } catch (err) {
    await setup.cleanup().catch(() => undefined);
    throw err;
  }
}

async function openSession(input: RunInput): Promise<LiveSession | undefined> {
  // The print transport starts a process per turn and keeps nothing alive, so it has no live session. The funnel runs it directly.
  if (transportOf(input) === "print") return undefined;
  return openAcp(input);
}

async function* runRaw(input: RunInput): AsyncGenerator<FunnelEvent> {
  if (transportOf(input) === "print") return yield* runPrint(input);
  const session = await openAcp(input);
  try {
    yield* session.turn(input);
  } finally {
    session.close();
  }
}

/** The run, with the run's secrets masked in what it reports as an error, as the other CLI providers do: agy quotes the address of a server as written. */
const run = (input: RunInput): AsyncGenerator<FunnelEvent> => redactErrors(runRaw(input), runSecrets(input));

/** How long agy gets to exit after its `result` before the run stops it. */
const EXIT_GRACE_MS = 1000;

/** How long `/usage` may take. It runs no model turn, so it answers at once. */
const USAGE_TIMEOUT_MS = 30_000;

/**
 * `agy --print=/usage` prints the account's limits in a `command_result` line and ends with a `result` that has no
 * turns. It spends no quota. It runs in the folder that `none` uses, which holds nothing of the user's.
 */
async function rateLimits(options: ProcessOptions = {}): Promise<RateLimits> {
  const path = findBinary("agy");
  if (!path) throw new FunnelError("agy is not installed.", "not-installed");
  const res = await exec(path, ["--print=/usage", "--output-format", "stream-json"], {
    cwd: await noneWorkspace(),
    env: { ...options.env, ...NO_GIT_ENV },
    signal: options.signal,
    timeoutMs: USAGE_TIMEOUT_MS,
  }).catch((e: unknown) => {
    throw new FunnelError(`agy could not run: ${e instanceof Error ? e.message : String(e)}`, "cli-failed");
  });
  if (options.signal?.aborted) throw new FunnelError("The request was aborted.", "aborted");
  const lines: Record<string, any>[] = [];
  for (const line of res.stdout.split("\n")) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") lines.push(parsed);
    } catch {
      // Not a stream line. Only the JSON lines matter here.
    }
  }
  const usage = lines.find((l) => l.event === "command_result" && l.command?.name === "usage");
  const failed = lines.find((l) => l.event === "result" && (l.result?.status === "ERROR" || l.result?.error));
  if (usage && !failed && res.code === 0) return parseRateLimits(usage.command.data);
  const output = (res.stderr + res.stdout).trim();
  if (/sign in|authentication required|not logged in/i.test(output)) throw new FunnelError("Run agy in a terminal and sign in.", "not-logged-in");
  if (failed) throw new FunnelError(`agy could not report its usage: ${String(failed.result.error ?? "the run failed")}`, "unsupported");
  if (res.code === null) throw new FunnelError("agy did not answer /usage in time.", "cli-failed");
  if (res.code !== 0) throw new FunnelError(stderrTail(res.stderr) || `agy exited with code ${res.code}.`, "cli-failed");
  throw new FunnelError("This agy does not report usage with /usage. Update agy.", "unsupported");
}

export const antigravityProvider: Provider = {
  id: "antigravity",
  displayName: "Antigravity",
  feedbackChannel: FEEDBACK_CHANNELS.antigravity,
  capabilities: {
    access: ["none", "accept-edits", "full"],
    effort: true,
    contextWindow: false,
    fast: false,
    resume: true,
    approvals: false,
    images: true,
    system: "native",
    // ACP has no schema field. The `print` transport passes `--json-schema`, but the default does not.
    schema: "prompt",
    mcpServers: ["http", "stdio"],
    // Not on Windows: the run refuses servers at `none` there with `unsupported`, see `requireMcpAtNoneHere`.
    mcpServersAtNone: ["http", "stdio"],
    apiKey: true,
    plan: true,
    fileChanges: true,
  },
  async detect() {
    const install = await detectInstallation("agy", TESTED);
    // The default transport needs `agy acp`, which 1.5.0 introduced. `print` runs on older builds.
    if (install.installed && install.version && compareVersions(install.version, ACP_MIN_VERSION) < 0) {
      return { ...install, detail: `agy ${ACP_MIN_VERSION} or newer is needed for the default ACP transport. This version runs only with providerOptions.antigravity.transport "print".` };
    }
    return install;
  },
  authStatus,
  login,
  async logout() {
    throw new FunnelError(
      "agy has no sign-out command. Run agy and open its account menu to sign out.",
      "unsupported",
    );
  },
  update: () => runUpdate("agy", ["update"]),
  rateLimits,
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
  openSession,
};
