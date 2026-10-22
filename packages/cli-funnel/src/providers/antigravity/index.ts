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
  type ModelInfo,
  type Provider,
  type ProviderContext,
  type RunInput,
  type Selection,
} from "../../types.js";
import { detectInstallation, exitedEarly, findBinary, LOGIN_TIMEOUT_MS, runUpdate } from "../base.js";
import { createMapper, parseModels } from "./parser.js";
import { composePrompt } from "../prompt.js";
import { dirList, flag, optionsFor, positive, requireAccess } from "../options.js";
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
 * `placed` is the prompt from `placePrompt`.
 */
export function buildArgs(
  input: RunInput,
  models: ModelInfo[] = [],
  platform: NodeJS.Platform = process.platform,
  schemaArg?: string,
  placed = placePrompt(input, platform),
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
    return { loggedIn: true, method: process.env.GEMINI_API_KEY ? "Gemini API key" : "Google account" };
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
  const cwd = input.selection.access === "none" ? await noneWorkspace() : input.selection.cwd;
  // A long schema would count against the command-line limit, so it goes through a private temp file removed after the run.
  const schema = input.responseSchema ? JSON.stringify(input.responseSchema.schema) : undefined;
  const schemaFile = schema && needsArgFile(schema) ? await writeArgFile("schema.json", schema) : undefined;
  const placed = placePrompt(input, process.platform);
  let stream: ReturnType<typeof spawnStream>;
  try {
    stream = spawnStream(path, buildArgs(input, models, process.platform, schemaFile?.path ?? schema, placed), {
      cwd,
      env: input.env,
      signal: input.signal,
      input: placed.stdin ?? "",
    });
  } catch (err) {
    await schemaFile?.remove();
    throw err;
  }
  const mapper = createMapper();
  try {
    for await (const line of stream.lines) {
      for (const e of mapper.map(line)) yield e;
    }
  } finally {
    // Runs too when the caller stops reading early. The CLI must not keep working unattended.
    stream.kill();
    await schemaFile?.remove();
  }
  if (!mapper.finished) yield await exitedEarly(stream, "agy", () => input.signal?.aborted);
}

export const antigravityProvider: Provider = {
  id: "antigravity",
  displayName: "Antigravity",
  binary: "agy",
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
