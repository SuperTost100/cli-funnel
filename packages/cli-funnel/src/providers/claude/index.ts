import { existsSync } from "node:fs";
import {
  ACCESS_LEVELS,
  FunnelError,
  type AccessLevel,
  type AuthStatus,
  type Capabilities,
  type FunnelEvent,
  type McpServer,
  type Provider,
  type ProviderContext,
  type Question,
  type QuestionAnswers,
  type QuestionRequest,
  type RunInput,
} from "../../types.js";
import { askApproval, askQuestion, detectInstallation, exitedEarly, findBinary, runLogout, runUpdate, spawnLogin } from "../base.js";
import { bool, dirList, flag, invalidOption, mcpServersFor, object, optionsFor, positive, requireAccess, str, stringList } from "../options.js";
import { manifestModels } from "../../catalog/manifest.js";
import { needsArgFile, writeArgFile, type ArgFile } from "../../util/argfile.js";
import { exec, spawnStream, type Streamed } from "../../util/process.js";
import { openClaudeSession } from "./live.js";
import { requireMachine } from "../../selection.js";
import { editPath, newClaudeTrack, parseClaudeMessage, type ClaudeTrack } from "./parser.js";

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
  approvalInput: true,
  images: true,
  system: "native",
  schema: "native",
  mcpServers: ["http", "stdio"],
  apiKey: true,
  plan: true,
  fileChanges: true,
  questions: true,
};

const MCP_KINDS: McpServer["type"][] = ["http", "stdio"];

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

/** True when tool prompts go to `onApproval`. `full` never prompts and `none` has no tools. */
function asksCaller(input: RunInput): boolean {
  const { access } = input.selection;
  return access !== "full" && access !== "none" && !!input.onApproval;
}

/** Names of the caller's HTTP MCP servers whose tool calls run without `onApproval`. */
function autoApproved(input: RunInput): Set<string> {
  return new Set(mcpServersFor(input, MCP_KINDS).flatMap(([name, s]) => (s.type === "http" && s.autoApprove ? [name] : [])));
}

/**
 * `--permission-prompt-tool stdio` sends tool prompts to the provider as `can_use_tool` requests. Without it the CLI
 * denies anything that needs a prompt, and it leaves out the AskUserQuestion tool. So it is on for approvals, for
 * questions, and for auto-approved MCP servers. Prompts the caller would not have been asked about before are denied
 * by the provider, as the CLI did (see `answerControlRequest`).
 */
function usesPromptTool(input: RunInput): boolean {
  const { access } = input.selection;
  if (access === "none") return false;
  if (input.onQuestion) return true;
  return asksCaller(input) || (access !== "full" && autoApproved(input).size > 0);
}

/** One server of `mcpServers` in Claude Code's `--mcp-config` shape. `timeout` is the per-server tool call limit in ms. */
function claudeMcpServer(s: McpServer): Record<string, unknown> {
  const timeout = s.toolTimeoutSec === undefined ? {} : { timeout: Math.round(s.toolTimeoutSec * 1000) };
  if (s.type === "http") return { type: "http", url: s.url, ...(s.headers ? { headers: s.headers } : {}), ...timeout };
  return { type: "stdio", command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}), ...timeout };
}

/**
 * The `--mcp-config` object: `providerOptions.claude.mcpConfig` with `mcpServers` added to its `mcpServers`. Undefined
 * when there is neither. A name in both is refused, so an auto-approved name always means the caller's own server.
 */
function mcpConfig(input: RunInput): Record<string, unknown> | undefined {
  const own = object(optionsFor(input, "claude", OPTION_KEYS).mcpConfig, "mcpConfig");
  // A stdio MCP server is a command that starts before any permission check.
  if (own) requireAccess(requireMachine(input.selection).access, ["full"], "mcpConfig");
  const servers = mcpServersFor(input, MCP_KINDS);
  if (!servers.length) return own;
  const merged: Record<string, unknown> = { ...object(own?.mcpServers, "mcpConfig.mcpServers") };
  for (const [name, server] of servers) {
    if (Object.hasOwn(merged, name)) invalidOption(`MCP server "${name}" is in both mcpServers and providerOptions.claude.mcpConfig.`);
    merged[name] = claudeMcpServer(server);
  }
  return { ...own, mcpServers: merged };
}

/**
 * `systemFile` carries a long system prompt. Without it the prompt goes inline. `schemaOnStdin` leaves out
 * `--json-schema` when the schema goes in the `initialize` request instead (see `schemaInit`). `mcpFile` holds the MCP
 * config when `mcpServers` is set, since its headers and env can carry secrets that argv would show to other users.
 * Without it the config goes inline.
 */
export function buildArgs(input: RunInput, systemFile?: string, schemaOnStdin = schemaInit(input) !== undefined, mcpFile?: string): string[] {
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
  if (usesPromptTool(input)) args.push("--permission-prompt-tool", "stdio");
  if (input.sessionId) args.push("--resume", input.sessionId);
  args.push(...optionArgs(input, mcpFile));
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
function optionArgs(input: RunInput, mcpFile?: string): string[] {
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
  const mcp = mcpConfig(input);
  if (mcp) args.push(flag("--mcp-config", mcpFile ?? JSON.stringify(mcp)));
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
 * private temp file; so does the MCP config of `mcpServers`, which can carry secrets. The CLI reads both at startup,
 * and the caller runs `removeFiles` once the first turn ends. `apiKey` goes in the CLI's environment, never in argv.
 * `signal` stops the process. A live session leaves it out: its process outlives the turn.
 */
export async function launchClaude(input: RunInput, signal?: AbortSignal): Promise<{ proc: Streamed; removeFiles: () => Promise<void> }> {
  const bin = findBinary(BIN);
  if (!bin) throw new FunnelError("Claude Code is not installed.", "not-installed");
  if (input.selection.access === "supervised" && !input.onApproval) {
    throw new FunnelError('Access "supervised" needs an onApproval handler.', "invalid-selection");
  }
  const files: ArgFile[] = [];
  const removeFiles = async () => {
    await Promise.all(files.map((f) => f.remove()));
  };
  const init = schemaInit(input);
  let proc: Streamed;
  try {
    const systemFile = input.system && needsArgFile(input.system) ? await writeArgFile("system-prompt.txt", input.system) : undefined;
    if (systemFile) files.push(systemFile);
    const mcp = mcpServersFor(input, MCP_KINDS).length ? await writeArgFile("mcp.json", JSON.stringify(mcpConfig(input))) : undefined;
    if (mcp) files.push(mcp);
    const args = buildArgs(input, systemFile?.path, init !== undefined, mcp?.path);
    // In print mode Claude Code uses ANTHROPIC_API_KEY from its environment over the saved login, with no approval step.
    // Sonnet 5 and Opus 5.5 get the task tools, and so `plan` events, only with this variable.
    const todo = input.planTool && input.selection.access !== "none" ? { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } : {};
    const env = { ...input.env, ...todo, ...(input.apiKey ? { ANTHROPIC_API_KEY: input.apiKey } : {}) };
    proc = spawnStream(bin, args, { cwd: input.selection.cwd, env, signal, closeStdin: false });
  } catch (err) {
    await removeFiles();
    throw err;
  }
  if (init) proc.write(init);
  return { proc, removeFiles };
}

/**
 * Reads one turn from `lines`: answers control requests and yields events up to and including `result`.
 * `state.finished` is set before a terminal event is yielded, since a consumer that stops at `done` never comes back.
 * `onResult` runs when `result` arrives, before its events are yielded. `track` lives as long as the process.
 */
export async function* claudeTurn(
  proc: Pick<Streamed, "write" | "exited">,
  lines: AsyncIterable<unknown>,
  input: RunInput,
  forward: boolean,
  state: { finished: boolean },
  track: ClaudeTrack,
  onResult?: () => void,
): AsyncGenerator<FunnelEvent> {
  const { cwd } = requireMachine(input.selection);
  for await (const raw of lines) {
    const msg = raw as Record<string, any>;
    if (msg.type === "control_request") {
      yield* answerControlRequest(proc, msg, input, track);
      continue;
    }
    if (msg.type === "result") onResult?.();
    for (const e of parseClaudeMessage(raw, forward, track)) {
      if (e.type === "tool.start") {
        // The kind of a file change depends on whether the file was there before the tool ran.
        const path = editPath(e.name, e.input, cwd);
        if (path) track.edits.set(e.id, { path, existed: existsSync(path) });
      }
      if (e.type === "done" || e.type === "error") state.finished = true;
      yield e;
    }
    if (msg.type === "result") return;
  }
}

async function* run(input: RunInput): AsyncGenerator<FunnelEvent> {
  const { proc, removeFiles } = await launchClaude(input, input.signal);
  proc.write(userMessage(input));
  const state = { finished: false };
  try {
    // Claude Code waits on stdin for another turn until it closes, so close it as soon as the result arrives.
    yield* claudeTurn(proc, proc.lines, input, forwardsSubagents(input), state, newClaudeTrack(), () => proc.closeStdin());
  } finally {
    proc.closeStdin();
    // After a result Claude Code exits on its own once stdin closes. Give it a moment to save the session, then stop it.
    if (state.finished) setTimeout(() => proc.kill(), 2000).unref();
    else proc.kill();
    await removeFiles();
  }
  if (!state.finished) yield await exitedEarly(proc, "Claude Code", () => input.signal?.aborted);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * AskUserQuestion's input as a QuestionRequest, or undefined when it has no questions. Question ids are the
 * question's position. Claude Code always lets the user type an answer of their own, so `allowOther` is always true.
 */
export function questionRequest(id: string, input: unknown): QuestionRequest | undefined {
  if (!isObj(input) || !Array.isArray(input.questions) || !input.questions.length) return undefined;
  const questions = input.questions.map((q, i): Question => {
    const o = isObj(q) ? q : {};
    const options = (Array.isArray(o.options) ? o.options : []).flatMap((opt) =>
      isObj(opt) && typeof opt.label === "string" ? [{ label: opt.label, ...(typeof opt.description === "string" ? { description: opt.description } : {}) }] : [],
    );
    return {
      id: String(i),
      ...(typeof o.header === "string" ? { header: o.header } : {}),
      question: typeof o.question === "string" ? o.question : "",
      options,
      multiSelect: o.multiSelect === true,
      allowOther: true,
    };
  });
  return { id, questions };
}

/**
 * Answers in the shape AskUserQuestion reads from `updatedInput.answers`: keyed by question text, with several
 * answers joined by ", ". Questions with no answer are left out.
 */
export function questionAnswers(request: QuestionRequest, answers: QuestionAnswers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of request.questions) {
    const a = answers[q.id];
    if (a?.length) out[q.question] = a.join(", ");
  }
  return out;
}

/** What the CLI tells the model when it denies a prompt by itself. Used for prompts the caller is not asked about. */
const notGranted = (tool: string) => `Claude requested permissions to use ${tool}, but you haven't granted it yet.`;

/**
 * Answers one `control_request` from Claude Code. With `onQuestion`, AskUserQuestion is yielded as `question.request`
 * and allowed with the answers. Tools of an auto-approved MCP server are allowed. Other tool approvals are yielded as
 * `approval.request` and answered with the caller's decision, or denied when the caller is not asked at this level.
 * When the run is cancelled or the CLI exits while waiting, nothing is answered: the caller's loop ends with the
 * process and reports why.
 */
async function* answerControlRequest(proc: Pick<Streamed, "write" | "exited">, msg: Record<string, any>, input: RunInput, track: ClaudeTrack): AsyncGenerator<FunnelEvent> {
  const req = msg.request ?? {};
  if (req.subtype !== "can_use_tool") {
    proc.write(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "unsupported request" } }));
    return;
  }
  const id = String(req.tool_use_id ?? msg.request_id);
  const tool = String(req.tool_name);
  const reply = (response: Obj) => proc.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } }));
  const deny = (message: string) => {
    track.declined.add(id);
    reply({ behavior: "deny", message });
  };

  const question = tool === "AskUserQuestion" && input.onQuestion ? questionRequest(id, req.input) : undefined;
  if (question) {
    yield { type: "question.request", request: question };
    const answers = await awaitReply(input, askQuestion(input, question), proc.exited);
    if (answers === undefined) return;
    if (answers === null) return deny("The user did not answer.");
    return reply({ behavior: "allow", updatedInput: { ...req.input, answers: questionAnswers(question, answers) } });
  }

  // `dynamic` servers come from --mcp-config, and a name there is either the caller's or refused (see `mcpConfig`).
  // The request names the server as configured, so another server whose tool names look the same does not match.
  const server = isObj(req.mcp_server) ? req.mcp_server : undefined;
  if (server?.source === "dynamic" && autoApproved(input).has(String(server.name))) return reply({ behavior: "allow", updatedInput: req.input });

  if (!asksCaller(input)) return deny(notGranted(tool));
  const request = { id, tool, input: req.input, description: req.description };
  yield { type: "approval.request", request };
  const decision = await awaitReply(input, askApproval(input, request), proc.exited);
  if (decision === undefined) return;
  if (decision.decision === "allow") reply({ behavior: "allow", updatedInput: decision.updatedInput ?? req.input });
  else deny(decision.message ?? "Denied by the user.");
}

/** Waits for the caller's answer, or undefined once the run is aborted or the CLI has exited. */
async function awaitReply<T>(input: RunInput, answer: Promise<T>, exited: Promise<unknown>): Promise<T | undefined> {
  const signal = input.signal;
  if (signal?.aborted) return undefined;
  let onAbort!: () => void;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([answer, aborted, exited.then(() => undefined)]);
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
  capabilities,
  detect: () => detectInstallation(BIN, TESTED_RANGE),
  authStatus,
  // `claude auth login` opens the browser itself and prints a fallback link.
  login: (options) => spawnLogin(BIN, ["auth", "login"], authStatus, { signal: options?.signal, opensBrowser: true }),
  logout: () => runLogout(BIN, ["auth", "logout"]),
  update: () => runUpdate(BIN, ["update"]),
  models: (ctx?: ProviderContext) => manifestModels("claude", ctx?.manifestUrl, claudeProvider.detect().then((i) => i.version)),
  run,
  openSession: openClaudeSession,
};
