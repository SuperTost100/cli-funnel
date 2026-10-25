import { FunnelError, type ApprovalDecision, type ApprovalRequest, type FunnelEvent, type LiveSession, type RunInput } from "../../types.js";
import { requireMachine } from "../../selection.js";
import { Channel } from "../../util/channel.js";
import { spawnStream } from "../../util/process.js";
import { redactErrors } from "../../util/redact.js";
import { askApproval, askQuestion, findBinary, stderrTail } from "../base.js";
import { planAccess } from "./access.js";
import { denyNote, effectiveReply, isQuestion, toApprovalRequest, toQuestionReply, toQuestionRequest, toReply, type Reply, type ServerRequest } from "./approvals.js";
import { authKind } from "./auth.js";
import { Translator } from "./events.js";
import { BINARY, INITIALIZE_PARAMS } from "./index.js";
import { agentConfig, threadOptions } from "./options.js";
import { RpcClient } from "./rpc.js";
import { configDeclares, noToolsConfig } from "./tools.js";

/**
 * Settings for `thread/start` and `thread/resume`, with `providerOptions.codex` and the agent features applied. At
 * `none` the no-tools config goes last, so nothing else can switch a tool back on.
 */
async function threadSettings(path: string, input: RunInput, agent: Record<string, unknown>) {
  const sel = input.selection;
  const machine = requireMachine(sel);
  const plan = planAccess(machine.access);
  const extra = threadOptions(input);
  const config = { ...extra.config, ...agent, ...(sel.access === "none" ? await noToolsConfig(path, machine.cwd, input.env) : {}) };
  return {
    model: sel.model,
    cwd: sel.cwd,
    approvalPolicy: extra.approvalPolicy ?? plan.approvalPolicy,
    approvalsReviewer: plan.approvalsReviewer,
    sandbox: plan.sandbox,
    ...(sel.fast ? { serviceTier: "priority" } : {}),
    ...(input.system ? { developerInstructions: input.system } : {}),
    ...(Object.keys(config).length ? { config } : {}),
  };
}

/**
 * App-server args. With an API key the app-server keeps credentials in memory only (`ephemeral`), so the
 * `account/login/start` that follows never writes `auth.json` or the keyring, and the saved login is not loaded.
 */
export function appServerArgs(input: RunInput): string[] {
  return input.apiKey ? ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"'] : ["app-server"];
}

/** Asks the caller's `onQuestion` and builds the reply. Without a handler the agent gets no answers. */
async function answerQuestion(req: ServerRequest, input: RunInput, push: (e: FunnelEvent) => void): Promise<Reply> {
  if (!input.onQuestion) return toQuestionReply(req, null);
  const request = toQuestionRequest(req);
  push({ type: "question.request", request });
  return toQuestionReply(req, await askQuestion(input, request));
}

/** Params for `turn/start`: the prompt, its images, and the per-turn settings. */
function turnParams(input: RunInput, threadId: string) {
  return {
    threadId,
    input: [
      ...(input.attachments ?? []).map((a) => ({ type: "image", url: `data:${a.mediaType};base64,${a.data}` })),
      { type: "text", text: input.prompt, text_elements: [] },
    ],
    ...(input.selection.effort ? { effort: input.selection.effort } : {}),
    ...(input.responseSchema ? { outputSchema: input.responseSchema.schema } : {}),
  };
}

/**
 * The answer to one approval request. Levels below `supervised` answer without asking. Otherwise `push` gets the
 * `approval.request` event and the caller's `onApproval` decides.
 */
async function decideApproval(
  req: ServerRequest,
  request: ApprovalRequest,
  input: RunInput,
  push: (e: FunnelEvent) => void,
): Promise<ApprovalDecision> {
  const access = input.selection.access;
  if (access === "none") return "deny";
  if (req.method === "item/fileChange/requestApproval" && planAccess(requireMachine(input.selection).access).autoAllowFileChanges) return "allow";
  if (access === "full") return "allow";
  push({ type: "approval.request", request });
  return askApproval(input, request);
}

interface Turn {
  input: RunInput;
  out: Channel<FunnelEvent>;
  translator: Translator;
  /** Resolves with the turn id once `turn/start` answered or `turn/started` arrived. */
  started: Promise<string>;
  setTurnId(id: string): void;
  /** Resolves when the turn ended. */
  ended: Promise<void>;
  end(): void;
  turnId?: string;
  finished: boolean;
  /** Events held back until the `session` event goes out, so it stays the first event of the turn. */
  held?: FunnelEvent[];
  /** Builds the `session` event once the thread is known. */
  session?: () => FunnelEvent;
}

/** How long Codex has to end an interrupted turn. After that the funnel ends it and drops the app-server. */
const INTERRUPT_GRACE_MS = 5000;

/**
 * How long the first `session` event waits for `account/read`, counted from when the request goes out. Measured on
 * 0.164: it answers about 580 ms after `initialize`, about 330 ms after `thread/start`, because it checks workspace
 * routing. `turn/start` is already on its way meanwhile, so the wait delays no work, only when the turn's events show.
 */
const AUTH_WAIT_MS = 1000;

/** Resolves when `p` settles or after `ms`, whichever comes first. */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  try {
    await Promise.race([p.then(() => undefined, () => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `turn/interrupt` was acknowledged. The turn can end a moment before its answer arrives, so wait briefly. */
async function acknowledged(interrupt: Promise<boolean> | undefined): Promise<boolean> {
  if (!interrupt) return false;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), 1000);
    timer.unref();
  });
  try {
    return await Promise.race([interrupt, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One `codex app-server` and one thread, kept across turns. Each turn is a `turn/start` on the same thread.
 * `steer` sends `turn/steer`, which adds a user message to the running turn.
 */
export async function openCodexSession(first: RunInput): Promise<LiveSession> {
  const path = findBinary(BINARY);
  if (!path) throw new FunnelError("codex is not installed.", "not-installed");
  // Refuses options that would widen access before a process starts. `start` holds the params only `thread/start` takes.
  const { start } = threadOptions(first);
  const agent = agentConfig(first);
  const taken = configDeclares(Object.keys(first.mcpServers ?? {}), requireMachine(first.selection).cwd, first.env);
  if (taken.length) {
    throw new FunnelError(`MCP server ${taken.join(", ")} is already in the user's Codex config. Give the server another name.`, "invalid-selection");
  }
  // No abort signal here: the process outlives the turn. Each turn handles its own signal.
  const proc = spawnStream(path, appServerArgs(first), { cwd: first.selection.cwd, env: first.env });
  proc.hold(false);
  let threadId: string | undefined;
  let model: string | undefined;
  let auth: "account" | "api-key" | undefined;
  /** Settles when `account/read` answered, or at once when the run uses an API key. */
  let authRead: Promise<unknown> = Promise.resolve();
  /** The thread's working directory, for relative file change paths. */
  let cwd = requireMachine(first.selection).cwd;
  let exited = false;
  let closed = false;
  let current: Turn | undefined;

  const emit = (t: Turn, e: FunnelEvent) => {
    if (t.held) t.held.push(e);
    else t.out.push(e);
  };

  /** Sends the `session` event, when the thread is known, then the events held back meanwhile. */
  const open = (t: Turn) => {
    const held = t.held;
    if (!held) return;
    t.held = undefined;
    if (t.session) t.out.push(t.session());
    for (const e of held) t.out.push(e);
  };

  const finish = (t: Turn, events: FunnelEvent[]) => {
    if (t.finished) return;
    open(t);
    t.finished = true;
    for (const e of events) t.out.push(e);
    t.out.end();
    t.end();
  };

  const stop = () => {
    closed = true;
    proc.kill();
  };

  const rpc = new RpcClient(proc, {
    notification(method, params) {
      const t = current;
      if (!t || t.finished) return;
      if (method === "turn/started" && params?.threadId === threadId && params.turn?.id) t.setTurnId(params.turn.id);
      const r = t.translator.handle(method, params);
      if (r.finished) finish(t, r.events);
      else for (const e of r.events) emit(t, e);
    },
    request(id, method, params) {
      const req: ServerRequest = { id, method, params: params ?? {} };
      const t = current;
      const live = t && !t.finished ? t : undefined;
      if (isQuestion(req)) {
        // Nobody can answer between turns.
        if (!live) rpc.respond(id, toQuestionReply(req, null));
        else void answerQuestion(req, live.input, (e) => emit(live, e)).then((r) => rpc.respond(id, r));
        return;
      }
      const request = live ? toApprovalRequest(req, live.translator) : undefined;
      if (!live || !request) {
        rpc.respond(id, toReply(req, "deny"));
        return;
      }
      void decideApproval(req, request, live.input, (e) => emit(live, e)).then(async (d) => {
        const reply = effectiveReply(d);
        // A decline has no reason field. The message goes first as a user message in the same turn, so the model reads
        // it together with the refusal.
        const note = denyNote(reply);
        const turnId = req.params.turnId ?? live.turnId;
        if (note && threadId && turnId && !live.finished) {
          await rpc.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: note, text_elements: [] }] }).catch(() => undefined);
        }
        rpc.respond(id, toReply(req, reply));
      });
    },
    closed() {
      exited = true;
      const t = current;
      if (!t) return;
      const err = stderrTail(proc.stderr());
      finish(t, [closed ? { type: "done", text: "", finishReason: "cancelled" } : { type: "error", message: `Codex app-server exited early.${err ? ` ${err}` : ""}` }]);
    },
  });

  // Started once. Every turn waits for it.
  const ready = (async () => {
    await rpc.request("initialize", INITIALIZE_PARAMS);
    rpc.notify("initialized");
    if (first.apiKey) {
      await rpc.request("account/login/start", { type: "apiKey", apiKey: first.apiKey });
      auth = "api-key";
    } else {
      // Not awaited here: `thread/start` goes out meanwhile. An app-server that does not know the method leaves `auth`
      // unset. The response can carry the account's email, which `authKind` drops.
      // The wait is capped once per process, so a slow answer delays only the first turn's events.
      authRead = within(
        rpc.request("account/read", { refreshToken: false }).then((res) => (auth ??= authKind(res))),
        AUTH_WAIT_MS,
      );
    }
    const settings = await threadSettings(path, first, agent);
    const started = first.sessionId
      ? await rpc.request("thread/resume", { threadId: first.sessionId, ...settings })
      : await rpc.request("thread/start", { ...settings, ...start });
    threadId = started.thread.id as string;
    model = started.model;
    if (typeof started.cwd === "string") cwd = started.cwd;
    return threadId;
  })();
  // A session that failed to start cannot take a turn. Stopping it makes the pool drop it.
  ready.catch(() => stop());

  async function* turn(input: RunInput): AsyncGenerator<FunnelEvent> {
    if (current && !current.finished) throw new FunnelError("A turn is already running in this session.", "invalid-selection");
    let setTurnId!: (id: string) => void;
    const started = new Promise<string>((resolve) => (setTurnId = resolve));
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    const t: Turn = {
      input,
      out: new Channel<FunnelEvent>(),
      translator: new Translator(threadId ?? "", cwd),
      started,
      setTurnId: (id) => {
        t.turnId ??= id;
        setTurnId(t.turnId);
      },
      ended,
      end,
      finished: false,
      held: [],
    };
    current = t;
    proc.hold(true);
    if (exited || closed) finish(t, [{ type: "error", message: "Codex app-server is not running.", code: "cli-failed" }]);

    const signal = input.signal;
    // Set when the abort arrived while the turn ran. An abort after the turn ended changes nothing.
    let aborted = false;
    // The answer to `turn/interrupt`: true when Codex acknowledged it.
    let interrupt: Promise<boolean> | undefined;
    let grace: NodeJS.Timeout | undefined;
    // Set when Codex did not end the turn within INTERRUPT_GRACE_MS and the funnel ended it instead.
    let forced = false;
    const onAbort = () => {
      if (t.finished) return;
      aborted = true;
      if (threadId && t.turnId) {
        interrupt = rpc.request("turn/interrupt", { threadId, turnId: t.turnId }).then(
          () => true,
          () => false,
        );
        grace = setTimeout(() => {
          forced = true;
          finish(t, [{ type: "done", text: "", finishReason: "cancelled" }]);
        }, INTERRUPT_GRACE_MS);
        grace.unref();
      } else {
        finish(t, [{ type: "done", text: "", finishReason: "cancelled" }]);
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    void (async () => {
      try {
        const id = await ready;
        if (t.finished) return;
        t.translator = new Translator(id, cwd);
        t.session = () => ({ type: "session", sessionId: id, model, ...(auth ? { auth } : {}) });
        const turnStart = rpc.request("turn/start", turnParams(input, id));
        turnStart.catch(() => undefined);
        await authRead;
        open(t);
        const res = await turnStart;
        if (res?.turn?.id) t.setTurnId(res.turn.id);
      } catch (e) {
        finish(t, [{ type: "error", message: e instanceof Error ? e.message : String(e), code: "cli-failed" }]);
      }
    })();

    let terminal = false;
    // Codex quotes the server's answer in errors, and a key could be in it.
    const events = first.apiKey ? redactErrors(t.out, [first.apiKey]) : t.out;
    try {
      for await (const e of events) {
        if (e.type === "done" || e.type === "error") terminal = true;
        yield e;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(grace);
      // A turn the consumer left before it ended leaves the thread in an unknown state. So does an aborted turn,
      // unless Codex acknowledged `turn/interrupt` and ended the turn itself. Then the thread is idle and reusable.
      const clean = !aborted || (!forced && (await acknowledged(interrupt)));
      if (!terminal || !clean) stop();
      if (current === t) current = undefined;
      proc.hold(false);
    }
  }

  return {
    get sessionId() {
      return threadId;
    },
    get alive() {
      return !exited && !closed;
    },
    turn,
    async steer(text: string) {
      const t = current;
      if (!t || t.finished) throw new FunnelError("No turn is running in this session.", "invalid-selection");
      const turnId = await Promise.race([t.started, t.ended.then(() => undefined)]);
      if (!turnId || t.finished) throw new FunnelError("The turn ended before the message could be added.", "invalid-selection");
      await rpc.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] });
    },
    close() {
      if (closed) return;
      const t = current;
      stop();
      if (t) finish(t, [{ type: "done", text: "", finishReason: "cancelled" }]);
    },
  };
}
