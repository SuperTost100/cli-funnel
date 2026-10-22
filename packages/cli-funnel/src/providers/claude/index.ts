import { ACCESS_LEVELS, FunnelError, type AccessLevel, type ApprovalDecision, type ApprovalRequest, type AuthStatus, type Capabilities, type FunnelEvent, type Provider, type ProviderContext, type RunInput } from "../../types.js";
import { askApproval, detectInstallation, exitedEarly, findBinary, runLogout, runUpdate, spawnLogin } from "../base.js";
import { bool, dirList, flag, invalidOption, object, optionsFor, positive, requireAccess, str, stringList } from "../options.js";
import { fromManifest, loadManifest } from "../../catalog/manifest.js";
import { needsArgFile, writeArgFile, type ArgFile } from "../../util/argfile.js";
import { exec, spawnStream, type Streamed } from "../../util/process.js";
import { openClaudeSession } from "./live.js";
import { requireMachine } from "../../selection.js";
import { parseClaudeMessage } from "./parser.js";

const BIN = "claude";
const TESTED_RANGE = { min: "2.1.0" };

const PERMISSION_MODE: Record<AccessLevel, string> = {
  // With every tool removed there is nothing to approve. `manual` keeps it that way if a tool slips in.
  none: "manual",
  supervised: "manual",
  "accept-edits": "acceptEdits",
  auto: "auto",
  full: "bypassPermissions",
};

const capabilities: Capabilities = {
  access: ["none", "supervised", "accept-edits", "auto", "full"],
  effort: true,
  contextWindow: true,
  fast: false,
  resume: true,
  approvals: true,
  images: true,
  system: "native",
  schema: "native",
};

/**
 * `none` removes every built-in tool, skips MCP servers and skips the user, project and local
 * settings files, so hooks, skills and CLAUDE.md do not load. Measured: a one-line prompt drops
 * from about 21,800 input tokens to about 400.
 */
const NO_TOOLS = ["--tools", "", "--strict-mcp-config", "--setting-sources", ""];

/** Claude Code picks the 1M context variant of a model through the `[1m]` suffix on the model id. */
function cliModel(selection: RunInput["selection"]): string {
  return selection.contextWindow === 1_000_000 && !selection.model.endsWith("[1m]") ? `${selection.model}[1m]` : selection.model;
}

/**
 * `systemFile` carries a long system prompt. Without it the prompt goes inline. `schemaOnStdin` leaves out
 * `--json-schema` when the schema goes in the `initialize` request instead (see `schemaInit`).
 */
export function buildArgs(input: RunInput, systemFile?: string, schemaOnStdin = schemaInit(input) !== undefined): string[] {
  const { selection } = input;
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", cliModel(selection),
    "--permission-mode", PERMISSION_MODE[requireMachine(selection).access],
  ];
  if (selection.effort) args.push("--effort", selection.effort);
  if (selection.access === "none") args.push(...NO_TOOLS);
  // `none` replaces Claude Code's coding-agent prompt. Other levels keep it and append.
  if (input.system) {
    const flag = selection.access === "none" ? "--system-prompt" : "--append-system-prompt";
    args.push(systemFile ? `${flag}-file` : flag, systemFile ?? input.system);
  }
  if (input.responseSchema && !schemaOnStdin) args.push("--json-schema", JSON.stringify(input.responseSchema.schema));
  // Without this flag the CLI denies anything that needs a prompt instead of asking.
  if (selection.access !== "full" && selection.access !== "none" && input.onApproval) args.push("--permission-prompt-tool", "stdio");
  if (input.sessionId) args.push("--resume", input.sessionId);
  args.push(...optionArgs(input));
  return args;
}

/**
 * `--json-schema` takes only inline JSON, so a schema too long for argv goes in the stream-json `initialize` control
 * request instead, the way the Agent SDK sends it. Returns that stdin line, or undefined when the flag is enough.
 */
function schemaInit(input: RunInput): string | undefined {
  if (!input.responseSchema || !needsArgFile(JSON.stringify(input.responseSchema.schema))) return undefined;
  const request = { subtype: "initialize", jsonSchema: input.responseSchema.schema };
  return JSON.stringify({ type: "control_request", request_id: "cli-funnel-init", request });
}

const OPTION_KEYS = ["allowedTools", "disallowedTools", "addDirs", "mcpConfig", "agents", "fallbackModel", "maxBudgetUsd", "forkSession", "forwardSubagentText", "betas"];
const AGENT_KEYS = ["description", "prompt", "tools", "disallowedTools", "model"];
const NOT_NONE = ACCESS_LEVELS.filter((a) => a !== "none");

/** Checks one custom subagent. Other keys, such as `permissionMode`, `mcpServers` or `hooks`, could widen access. */
function agentDefinition(name: string, value: unknown): Record<string, unknown> {
  const where = `agents.${name}`;
  const def = object(value, where)!;
  const unknown = Object.keys(def).filter((k) => !AGENT_KEYS.includes(k));
  if (unknown.length) invalidOption(`Unknown key ${unknown.join(", ")} in ${where}. Known: ${AGENT_KEYS.join(", ")}.`);
  if (!str(def.description, `${where}.description`) || !str(def.prompt, `${where}.prompt`)) {
    invalidOption(`${where} needs a description and a prompt.`);
  }
  stringList(def.tools, `${where}.tools`);
  stringList(def.disallowedTools, `${where}.disallowedTools`);
  str(def.model, `${where}.model`);
  return def;
}

/**
 * Flags for `providerOptions.claude`. Throws `invalid-selection` when an option would widen `selection.access`.
 * Values use the `--flag=value` form, so a value that starts with a dash is never read as a flag.
 */
function optionArgs(input: RunInput): string[] {
  const o = optionsFor(input, "claude", OPTION_KEYS);
  const { access } = requireMachine(input.selection);
  const args: string[] = [];
  const allowed = stringList(o.allowedTools, "allowedTools");
  if (allowed) {
    requireAccess(access, ["full"], "allowedTools");
    for (const t of allowed) args.push(flag("--allowed-tools", t));
  }
  for (const t of stringList(o.disallowedTools, "disallowedTools") ?? []) args.push(flag("--disallowed-tools", t));
  const dirs = dirList(o.addDirs, "addDirs");
  if (dirs) {
    requireAccess(access, NOT_NONE, "addDirs");
    for (const d of dirs) args.push(flag("--add-dir", d));
  }
  const mcp = object(o.mcpConfig, "mcpConfig");
  if (mcp) {
    // A stdio MCP server is a command that starts before any permission check.
    requireAccess(access, ["full"], "mcpConfig");
    args.push(flag("--mcp-config", JSON.stringify(mcp)));
  }
  const agents = object(o.agents, "agents");
  if (agents) {
    requireAccess(access, NOT_NONE, "agents");
    for (const [name, def] of Object.entries(agents)) agentDefinition(name, def);
    args.push(flag("--agents", JSON.stringify(agents)));
  }
  const fallback = str(o.fallbackModel, "fallbackModel");
  if (fallback) args.push(flag("--fallback-model", fallback));
  const budget = positive(o.maxBudgetUsd, "maxBudgetUsd");
  if (budget !== undefined) args.push(flag("--max-budget-usd", budget));
  if (bool(o.forkSession, "forkSession")) {
    if (!input.sessionId) invalidOption("forkSession needs a sessionId to fork from.");
    args.push("--fork-session");
  }
  if (bool(o.forwardSubagentText, "forwardSubagentText")) args.push("--forward-subagent-text");
  for (const b of stringList(o.betas, "betas") ?? []) args.push(flag("--betas", b));
  return args;
}

/** True when the run asked for `--forward-subagent-text`, so its parser keeps the subagents' text. */
export const forwardsSubagents = (input: RunInput): boolean => input.providerOptions?.claude?.forwardSubagentText === true;

/** Plain text, or content blocks when images are attached. Same block shape as the Messages API. */
export function userContent(input: RunInput): string | unknown[] {
  if (!input.attachments?.length) return input.prompt;
  return [
    ...input.attachments.map((a) => ({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } })),
    { type: "text", text: input.prompt },
  ];
}

/** The stdin line that starts a turn. */
export const userMessage = (input: RunInput): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: userContent(input) } });

/**
 * Checks the run and starts Claude Code. A long system prompt would hit the argv size limit, so it goes through a
 * private temp file in `systemFile`; the CLI reads it at startup, and the caller removes it once the first turn ends.
 * `signal` stops the process. A live session leaves it out: its process outlives the turn.
 */
export async function launchClaude(input: RunInput, signal?: AbortSignal): Promise<{ proc: Streamed; systemFile?: ArgFile }> {
  const bin = findBinary(BIN);
  if (!bin) throw new FunnelError("Claude Code is not installed.", "not-installed");
  if (input.selection.access === "supervised" && !input.onApproval) {
    throw new FunnelError('Access "supervised" needs an onApproval handler.', "invalid-selection");
  }
  const systemFile = input.system && needsArgFile(input.system) ? await writeArgFile("system-prompt.txt", input.system) : undefined;
  const init = schemaInit(input);
  let proc: Streamed;
  try {
    proc = spawnStream(bin, buildArgs(input, systemFile?.path, init !== undefined), { cwd: input.selection.cwd, env: input.env, signal, closeStdin: false });
  } catch (err) {
    await systemFile?.remove();
    throw err;
  }
  if (init) proc.write(init);
  return { proc, systemFile };
}

/**
 * Reads one turn from `lines`: answers control requests and yields events up to and including `result`.
 * `state.finished` is set before a terminal event is yielded, since a consumer that stops at `done` never comes back.
 * `onResult` runs when `result` arrives, before its events are yielded.
 */
export async function* claudeTurn(
  proc: Streamed,
  lines: AsyncIterable<unknown>,
  input: RunInput,
  forward: boolean,
  state: { finished: boolean },
  onResult?: () => void,
): AsyncGenerator<FunnelEvent> {
  for await (const raw of lines) {
    const msg = raw as Record<string, any>;
    if (msg.type === "control_request") {
      yield* answerControlRequest(proc, msg, input);
      continue;
    }
    if (msg.type === "result") onResult?.();
    for (const e of parseClaudeMessage(raw, forward)) {
      if (e.type === "done" || e.type === "error") state.finished = true;
      yield e;
    }
    if (msg.type === "result") return;
  }
}

async function* run(input: RunInput): AsyncGenerator<FunnelEvent> {
  const { proc, systemFile } = await launchClaude(input, input.signal);
  proc.write(userMessage(input));
  const state = { finished: false };
  try {
    // Claude Code waits on stdin for another turn until it closes, so close it as soon as the result arrives.
    yield* claudeTurn(proc, proc.lines, input, forwardsSubagents(input), state, () => proc.closeStdin());
  } finally {
    proc.closeStdin();
    // After a result Claude Code exits on its own once stdin closes. Give it a moment to save the session, then stop it.
    if (state.finished) setTimeout(() => proc.kill(), 2000).unref();
    else proc.kill();
    await systemFile?.remove();
  }
  if (!state.finished) yield await exitedEarly(proc, "Claude Code", () => input.signal?.aborted);
}

/**
 * Answers one `control_request` from Claude Code. A tool approval is yielded as `approval.request` and answered with the
 * caller's decision. When the run is cancelled or the CLI exits while waiting, nothing is answered: the caller's loop
 * ends with the process and reports why.
 */
async function* answerControlRequest(proc: Streamed, msg: Record<string, any>, input: RunInput): AsyncGenerator<FunnelEvent> {
  const req = msg.request ?? {};
  if (req.subtype !== "can_use_tool") {
    proc.write(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "unsupported request" } }));
    return;
  }
  const request = { id: String(req.tool_use_id ?? msg.request_id), tool: String(req.tool_name), input: req.input, description: req.description };
  yield { type: "approval.request", request };
  const decision = await awaitApproval(input, request, proc.exited);
  if (decision === undefined) return;
  const response = decision === "allow" ? { behavior: "allow", updatedInput: req.input } : { behavior: "deny", message: "Denied by the user." };
  proc.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } }));
}

/** Waits for the caller's decision, or undefined once the run is aborted or the CLI has exited. */
async function awaitApproval(input: RunInput, request: ApprovalRequest, exited: Promise<unknown>): Promise<ApprovalDecision | undefined> {
  const signal = input.signal;
  if (signal?.aborted) return undefined;
  let onAbort!: () => void;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([askApproval(input, request), aborted, exited.then(() => undefined)]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function authStatus(): Promise<AuthStatus> {
  const bin = findBinary(BIN);
  if (!bin) return { loggedIn: false, detail: "Claude Code is not installed." };
  const res = await exec(bin, ["auth", "status"], { timeoutMs: 15_000 });
  try {
    const j = JSON.parse(res.stdout);
    return { loggedIn: j.loggedIn === true, method: j.authMethod, account: j.email, plan: j.subscriptionType };
  } catch {
    return { loggedIn: false, detail: (res.stderr || res.stdout).trim() || undefined };
  }
}

export const claudeProvider: Provider = {
  id: "claude",
  displayName: "Claude Code",
  binary: BIN,
  capabilities,
  detect: () => detectInstallation(BIN, TESTED_RANGE),
  authStatus,
  // `claude auth login` opens the browser itself and prints a fallback link.
  login: (options) => spawnLogin(BIN, ["auth", "login"], authStatus, { signal: options?.signal, opensBrowser: true }),
  logout: () => runLogout(BIN, ["auth", "logout"]),
  update: () => runUpdate(BIN, ["update"]),
  async models(ctx?: ProviderContext) {
    const [manifest, install] = await Promise.all([loadManifest(ctx?.manifestUrl), claudeProvider.detect()]);
    return fromManifest(manifest, "claude", install.version);
  },
  run,
  openSession: openClaudeSession,
};
