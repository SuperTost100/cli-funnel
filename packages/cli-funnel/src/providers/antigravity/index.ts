import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fromManifest, loadBundledManifest, mergeModels } from "../../catalog/manifest.js";
import { Channel } from "../../util/channel.js";
import { exec, spawnStream } from "../../util/process.js";
import {
  FunnelError,
  type AuthStatus,
  type FunnelEvent,
  type LoginEvent,
  type LoginSession,
  type ModelInfo,
  type Provider,
  type RunInput,
  type Selection,
} from "../../types.js";
import { detectInstallation, findBinary, runUpdate } from "../base.js";
import { createMapper, parseModels } from "./parser.js";
import { composePrompt } from "../prompt.js";
import { ownedWorkspace } from "../../util/workspace.js";

const TOKEN_FILE = join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
const TESTED = { min: "1.2.0" };

/** Builds the `--model` / `--effort` pair. Base ids with effort variants need `--effort`. */
export function toCliModel(selection: Selection, models: ModelInfo[] = []): { model: string; effort?: string } {
  const info = models.find((m) => m.id === selection.model);
  const effort = selection.effort ?? (info?.efforts.length ? info.defaultEffort : undefined);
  return { model: selection.model, effort };
}

export function buildArgs(input: RunInput, models: ModelInfo[] = []): string[] {
  const { selection } = input;
  const { model, effort } = toCliModel(selection, models);
  const args = ["--print=" + composePrompt(input, { system: true, schema: false }), "--output-format", "stream-json", "--model", model];
  if (input.responseSchema) args.push("--json-schema", JSON.stringify(input.responseSchema.schema));
  if (effort) args.push("--effort", effort);
  if (selection.access === "accept-edits") args.push("--mode", "accept-edits");
  if (selection.access === "full") args.push("--dangerously-skip-permissions");
  if (input.sessionId) args.push("--conversation", input.sessionId);
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

async function loadManifestModels(): Promise<ModelInfo[]> {
  return fromManifest(await loadBundledManifest(), "antigravity");
}

async function authStatus(): Promise<AuthStatus> {
  const path = findBinary("agy");
  if (!path) return { loggedIn: false, detail: "agy is not installed." };
  const apiKey = !!process.env.GEMINI_API_KEY;
  if (!apiKey && !existsSync(TOKEN_FILE)) return { loggedIn: false, detail: "Run agy in a terminal and sign in." };
  const res = await exec(path, ["models"], { timeoutMs: 20_000 }).catch(() => undefined);
  const ok = !!res && res.code === 0 && parseModels(res.stdout).length > 0;
  return ok
    ? { loggedIn: true, method: apiKey ? "Gemini API key" : "Google account" }
    : { loggedIn: false, detail: "agy could not list models. Sign in again." };
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
    const deadline = Date.now() + 10 * 60_000;
    while (!cancelled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
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
  const models = await loadManifestModels();
  const cwd = input.selection.access === "none" ? await noneWorkspace() : input.selection.cwd;
  const stream = spawnStream(path, buildArgs(input, models), {
    cwd,
    env: input.env,
    signal: input.signal,
    input: "",
  });
  const mapper = createMapper();
  for await (const line of stream.lines) {
    for (const e of mapper.map(line)) yield e;
  }
  const code = await stream.exited;
  if (mapper.finished) return;
  if (input.signal?.aborted) return void (yield { type: "done", text: "", finishReason: "cancelled" });
  const detail = stream.stderr().trim().split("\n").slice(-3).join(" ");
  yield { type: "error", message: `agy exited (${code}) without a result. ${detail}`.trim(), code: "cli-failed" };
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
      "agy has no sign-out command. Run agy, open its account menu to sign out, or delete the token file in ~/.gemini/antigravity-cli/.",
      "unsupported",
    );
  },
  update: () => runUpdate("agy", ["update"]),
  async models() {
    const fallback = await loadManifestModels();
    const path = findBinary("agy");
    if (!path) return fallback;
    const res = await exec(path, ["models"], { timeoutMs: 20_000 }).catch(() => undefined);
    const live = res && res.code === 0 ? parseModels(res.stdout) : [];
    return live.length ? mergeModels(live, fallback) : fallback;
  },
  run,
};
