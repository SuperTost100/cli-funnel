import { FunnelError, type FunnelEvent, type LiveSession, type ModelInfo, type RunInput } from "../../../types.js";
import { Channel } from "../../../util/channel.js";
import { packageVersion } from "../../../util/package-version.js";
import { compareVersions, spawnStream } from "../../../util/process.js";
import { requireMachine } from "../../../selection.js";
import { composePrompt } from "../../prompt.js";
import { rawEvent, stderrTail } from "../../base.js";
import { NO_GIT_ENV } from "../../../util/workspace.js";
import { createNoneGuard } from "../../none-guard.js";
import { AGY_REFUSAL } from "../deny.js";
import { runSecrets } from "../../../util/redact.js";
import { AcpClient, AcpError } from "./client.js";
import {
  ACP_MIN_VERSION,
  agentFacts,
  checkThought,
  createAcpMapper,
  currentModel,
  currentThought,
  allows,
  decidePermission,
  denyPermission,
  failureFromError,
  failureFromTurn,
  initializeParams,
  modelsFromSession,
  planModel,
  promptBlocks,
  sessionMeta,
  thoughtLevels,
  type AgentFacts,
  type Failure,
} from "./protocol.js";

/** What `index.ts` works out before a process starts: the checked options, the folder and the files the run owns. */
export interface AcpSetup {
  path: string;
  /** The folder `agy acp` runs in and the session works in. */
  cwd: string;
  /** The arguments after `acp`: `--add-dir`, `--dangerously-skip-permissions`. */
  args: string[];
  env?: Record<string, string | undefined>;
  /** Runs before every turn: puts the run's folder and its hook back as they should be. A failure ends the turn. */
  refresh?: () => Promise<void>;
  /** Ends the turn after this many seconds, as `providerOptions.antigravity.printTimeoutSec`. */
  timeoutSec?: number;
  /** Where agy keeps conversation files, for the task list that becomes a `plan` event. */
  brainDir: string;
  readText(path: string): string | undefined;
  createdInRun(startedAt: number): ((path: string) => boolean | undefined) | undefined;
  /** The caller's MCP servers in the shape `session/new` takes, sent again on every activation. */
  mcpServers: unknown[];
  /** Each reserved name the servers were given to agy under, and the caller's own name for it. */
  mcpCallers?: ReadonlyMap<string, string>;
  /** At `none`: the reserved names whose tool calls are allowed. Every other permission request is denied. */
  allowMcp?: ReadonlySet<string>;
  /** The default thinking level of a model from the model list, for a run that names none. */
  defaultEffort(model: string): string | undefined;
  /** Gets the models the account's session listed. */
  onModels(models: ModelInfo[]): void;
  /** Removes what the run owns: temp folders. Runs once, when the process ends. */
  cleanup(): Promise<void>;
}

/** How long agy gets to end a cancelled turn. After that the turn ends as cancelled and the process stops. */
const CANCEL_GRACE_MS = 5000;

/** `CLI_FUNNEL_ACP_CANCEL_GRACE_MS` shortens the grace in tests. */
const cancelGrace = (): number => Number(process.env.CLI_FUNNEL_ACP_CANCEL_GRACE_MS) || CANCEL_GRACE_MS;

/** How long a setup request may take. `session/new` answers in a few hundred milliseconds. */
const SETUP_TIMEOUT_MS = 60_000;

const TOO_OLD = (version: string | undefined) =>
  `agy ${version ?? "(unknown version)"} is too old for the ACP transport, which needs ${ACP_MIN_VERSION} or newer. Update agy, or run with providerOptions.antigravity.transport "print".`;

interface Turn {
  input: RunInput;
  out: Channel<FunnelEvent>;
  mapper?: ReturnType<typeof createAcpMapper>;
  /** The check that keeps a tool from finishing at `none`. Made for this turn only. */
  guard?: ReturnType<typeof createNoneGuard>;
  finished: boolean;
  /** True until the output channel is closed. A verbose turn waits a moment after `finished`, and what arrives in it is kept. */
  open: boolean;
  end(): void;
  ended: Promise<void>;
}

/** Races `p` against a timer, so a hung agent cannot hold a run open. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FunnelError(`agy acp did not answer ${what} in time.`, "cli-failed")), ms);
    timer.unref();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * One `agy acp` process and one conversation, kept across turns. A one-shot run opens it, runs one turn and closes it.
 * The process serves one session, so the system prompt, the model and the thinking level are set when it starts.
 */
export async function openAcpSession(first: RunInput, setup: AcpSetup): Promise<LiveSession> {
  const access = requireMachine(first.selection).access;
  const proc = spawnStream(setup.path, ["acp", ...setup.args], { cwd: setup.cwd, env: access === "none" ? { ...first.env, ...NO_GIT_ENV } : first.env });
  proc.hold(false);
  let sessionId: string | undefined;
  let facts: AgentFacts | undefined;
  let model: string | undefined;
  let exited = false;
  let closed = false;
  let current: Turn | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    void setup.cleanup().catch(() => undefined);
  };

  const stop = () => {
    closed = true;
    proc.kill();
  };
  // Only `finish` may complete at `none`, which ends a turn and carries nothing out, and the calls the mapper knows are
  // the run's own MCP servers. A call to a user's server is neither. The mapper decides at the end of the call, with the
  // arguments of its last update, because a call can name its server in a later update than the first. One guard per
  // turn, so a live session does not keep the arguments of every call it ever made.
  const newGuard = (mapper: () => ReturnType<typeof createAcpMapper> | undefined) =>
    access === "none" ? createNoneGuard((start) => start.name !== "finish" && !mapper()?.isMcp(start.id), AGY_REFUSAL) : undefined;

  const finish = (t: Turn, events: FunnelEvent[]) => {
    if (t.finished) return;
    t.finished = true;
    const close = () => {
      t.open = false;
      for (const e of events) t.out.push(e);
      t.out.end();
      t.end();
    };
    // Stderr comes through another pipe. A verbose turn gives stderr written just before the end time to arrive.
    if (t.input.verbose) setTimeout(close, 20);
    else close();
  };

  const fail = (t: Turn, failure: Failure) =>
    finish(t, [...(failure.limit ? [{ type: "limit" as const, ...failure.limit }] : []), { type: "error", message: failure.message, code: failure.code }]);

  const rpc = new AcpClient(proc, {
    line(raw) {
      const t = current;
      if (t?.open && t.input.verbose) t.out.push(rawEvent("antigravity", "stdout", raw, t.input));
    },
    notification(method, params) {
      const t = current;
      if (method !== "session/update" || !t || t.finished || !t.mapper || params?.sessionId !== sessionId) return;
      for (const e of t.mapper.update(params.update ?? {})) {
        // The hook that refuses tools is agy's own. A tool that finishes at `none` means it did not apply.
        const reason = t.guard?.check(e);
        if (reason) {
          stop();
          return finish(t, [{ type: "error", message: reason, code: "cli-failed" }]);
        }
        t.out.push(e);
      }
    },
    request(id, method, params) {
      const t = current;
      if (method === "session/request_permission") {
        const answer = setup.allowMcp ? decidePermission(params, setup.allowMcp) : denyPermission(params);
        // Only a rejection makes the call's later failure a denial. A call that was allowed and then failed is a failure.
        const toolCallId = params?.toolCall?.toolCallId;
        if (typeof toolCallId === "string" && !allows(answer, params)) t?.mapper?.refuse(toolCallId);
        rpc.respond(id, answer);
        return;
      }
      // Nothing was offered at `initialize`, so a request for a file or a terminal is the agent's mistake.
      rpc.fail(id, -32601, `Method not found: ${method}`);
    },
    closed() {
      exited = true;
      cleanup();
      const t = current;
      if (!t) return;
      const err = stderrTail(proc.stderr());
      finish(t, [closed ? { type: "done", text: "", finishReason: "cancelled" } : { type: "error", message: `agy acp exited early.${err ? ` ${err}` : ""}`, code: /sign in|not logged in/i.test(err) ? "not-logged-in" : "cli-failed" }]);
    },
  });

  // Started once. Every turn waits for it.
  const ready = (async () => {
    const init = await within(rpc.request("initialize", initializeParams(packageVersion() ?? "0.0.0")), SETUP_TIMEOUT_MS, "initialize");
    facts = agentFacts(init);
    if (!facts.version || compareVersions(facts.version, ACP_MIN_VERSION) < 0) throw new FunnelError(TOO_OLD(facts.version), "unsupported");
    if (first.attachments?.length && !facts.images) throw new FunnelError("This agy cannot take image attachments over ACP.", "unsupported");
    const params = { cwd: setup.cwd, mcpServers: setup.mcpServers, ...(sessionMeta(first.system, facts) ? { _meta: sessionMeta(first.system, facts) } : {}) };
    let started: Record<string, any>;
    try {
      if (first.sessionId) {
        if (!facts.resume && !facts.load) throw new FunnelError("This agy cannot resume a conversation over ACP.", "unsupported");
        started = (await within(rpc.request(facts.resume ? "session/resume" : "session/load", { ...params, sessionId: first.sessionId }), SETUP_TIMEOUT_MS, "the conversation")) ?? {};
        sessionId = first.sessionId;
      } else {
        started = await within(rpc.request("session/new", params), SETUP_TIMEOUT_MS, "session/new");
        sessionId = String(started.sessionId ?? "");
        if (!sessionId) throw new FunnelError("agy acp started no session.", "cli-failed");
      }
    } catch (e) {
      if (!(e instanceof AcpError)) throw e;
      if (first.sessionId && /failed to read session|not found/i.test(e.message)) {
        throw new FunnelError(`Conversation ${first.sessionId} was not found.`, "cli-failed");
      }
      const failure = failureFromError(e);
      throw new FunnelError(failure.message, failure.code);
    }
    const live = modelsFromSession(started.models);
    if (live.length) setup.onModels(live);
    // A resumed session answers with the account's default model, so the selection is applied on every activation.
    let options: unknown = started.configOptions;
    const effort = first.selection.effort ?? setup.defaultEffort(first.selection.model);
    const plan = planModel(options, first.selection.model, effort);
    const set = async (configId: string, value: string) => {
      const answer = await within(rpc.request("session/set_config_option", { sessionId, configId, value }), SETUP_TIMEOUT_MS, `the ${configId} setting`);
      options = answer?.configOptions ?? options;
    };
    if (plan.model !== currentModel(options)) await set("model", plan.model);
    // A model without a thinking option takes no level, and `validateSelection` has already refused one the caller named.
    if (plan.thought && thoughtLevels(options).length) {
      checkThought(options, plan.model, plan.thought);
      if (plan.thought !== currentThought(options)) await set("thought_level", plan.thought);
    }
    model = plan.model;
    if (access === "accept-edits") await within(rpc.request("session/set_mode", { sessionId, modeId: "accept-edits" }), SETUP_TIMEOUT_MS, "the mode");
    return sessionId;
  })();
  // A session that failed to start cannot take a turn. Stopping it makes the pool drop it.
  ready.catch(() => stop());

  async function* turn(input: RunInput): AsyncGenerator<FunnelEvent> {
    if (current && !current.finished) throw new FunnelError("A turn is already running in this session.", "invalid-selection");
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    const t: Turn = { input, out: new Channel<FunnelEvent>(), guard: newGuard(() => t.mapper), finished: false, open: true, end, ended };
    current = t;
    proc.hold(true);
    const offStderr = input.verbose ? proc.onStderr((line) => t.open && t.out.push(rawEvent("antigravity", "stderr", line, input)), runSecrets(input)) : undefined;
    if (exited || closed) finish(t, [{ type: "error", message: "agy acp is not running.", code: "cli-failed" }]);

    const signal = input.signal;
    let aborted = false;
    let grace: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    let forced = false;
    const cancel = () => {
      if (t.finished || aborted) return;
      aborted = true;
      if (sessionId) rpc.notify("session/cancel", { sessionId });
      // agy ends a cancelled prompt with its own answer. If it does not, the funnel ends the turn and stops the process.
      grace = setTimeout(() => {
        forced = true;
        // Stop it here: a consumer that has stopped reading would leave the process running until it drained the stream.
        stop();
        finish(t, [{ type: "done", text: "", finishReason: "cancelled" }]);
      }, cancelGrace());
      grace.unref();
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    if (setup.timeoutSec) {
      timer = setTimeout(cancel, setup.timeoutSec * 1000);
      timer.unref();
    }

    void (async () => {
      try {
        const id = await ready;
        if (t.finished) return;
        if (aborted) return finish(t, [{ type: "done", text: "", finishReason: "cancelled" }]);
        await setup.refresh?.();
        if (t.finished) return;
        // An abort that came while the folder was put right found no prompt to cancel, and none may go out now.
        if (aborted) return finish(t, [{ type: "done", text: "", finishReason: "cancelled" }]);
        const startedAt = Date.now();
        t.mapper = createAcpMapper(id, { access, mcp: setup.mcpCallers, cwd: setup.cwd, brainDir: setup.brainDir, readText: setup.readText, createdInRun: setup.createdInRun(startedAt) });
        t.out.push({ type: "session", sessionId: id, ...(model ? { model } : {}) });
        // The system prompt went in with the session when agy takes one there, and goes in front of the prompt when not.
        const text = composePrompt(input, { system: !facts || sessionMeta(first.system, facts) === undefined, schema: true });
        const result = await rpc.request("session/prompt", { sessionId: id, prompt: promptBlocks(text, input.attachments) });
        if (t.finished) return;
        const stopReason = String(result?.stopReason ?? "end_turn");
        const failure = failureFromTurn(stopReason, t.mapper.text);
        if (failure) {
          fail(t, failure);
          return;
        }
        // A generic MCP call that never said whose it was is let out now, so the guard sees that it began and never ended.
        for (const e of t.mapper.flush()) {
          t.guard?.check(e);
          t.out.push(e);
        }
        // A forbidden call that never ended may have run, so the turn does not end as done.
        const unfinished = t.guard?.unfinished();
        if (unfinished) {
          stop();
          return finish(t, [{ type: "error", message: unfinished, code: "cli-failed" }]);
        }
        finish(t, t.mapper.finish(stopReason, result?.usage));
      } catch (e) {
        if (t.finished) return;
        if (aborted) finish(t, [{ type: "done", text: "", finishReason: "cancelled" }]);
        else if (e instanceof AcpError) fail(t, failureFromError(e));
        else finish(t, [{ type: "error", message: e instanceof Error ? e.message : String(e), code: e instanceof FunnelError ? e.code : "cli-failed" }]);
      }
    })();

    let terminal = false;
    try {
      for await (const e of t.out) {
        if (e.type === "done" || e.type === "error") terminal = true;
        yield e;
      }
    } finally {
      offStderr?.();
      signal?.removeEventListener("abort", cancel);
      clearTimeout(grace);
      clearTimeout(timer);
      // A turn the consumer left before it ended leaves the conversation in an unknown state. An aborted turn that agy
      // ended by itself leaves it idle and reusable.
      if (!terminal || forced) stop();
      if (current === t) current = undefined;
      proc.hold(false);
    }
  }

  return {
    get sessionId() {
      return sessionId;
    },
    get alive() {
      return !exited && !closed;
    },
    turn,
    close() {
      if (closed) return;
      const t = current;
      stop();
      if (t) finish(t, [{ type: "done", text: "", finishReason: "cancelled" }]);
    },
  };
}
