import { FunnelError, type ApprovalDecision, type ApprovalRequest, type FunnelEvent, type LiveSession, type RunInput } from "../../types.js";
import { requireMachine } from "../../selection.js";
import { Channel } from "../../util/channel.js";
import { spawnStream } from "../../util/process.js";
import { askApproval, findBinary, stderrTail } from "../base.js";
import { planAccess } from "./access.js";
import { toApprovalRequest, toReply, type ServerRequest } from "./approvals.js";
import { Translator } from "./events.js";
import { BINARY, INITIALIZE_PARAMS } from "./index.js";
import { threadOptions } from "./options.js";
import { RpcClient } from "./rpc.js";
import { noToolsConfig } from "./tools.js";

/** Settings for `thread/start` and `thread/resume`, with `providerOptions.codex` applied. */
async function threadSettings(path: string, input: RunInput) {
  const sel = input.selection;
  const machine = requireMachine(sel);
  const plan = planAccess(machine.access);
  const extra = threadOptions(input);
  return {
    model: sel.model,
    cwd: sel.cwd,
    approvalPolicy: extra.approvalPolicy ?? plan.approvalPolicy,
    approvalsReviewer: plan.approvalsReviewer,
    sandbox: plan.sandbox,
    ...(sel.fast ? { serviceTier: "priority" } : {}),
    ...(input.system ? { developerInstructions: input.system } : {}),
    ...(sel.access === "none" ? { config: await noToolsConfig(path, machine.cwd, input.env) } : {}),
    ...(sel.access !== "none" && Object.keys(extra.config).length ? { config: extra.config } : {}),
  };
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
}

/** How long Codex has to end an interrupted turn. After that the funnel ends it and drops the app-server. */
const INTERRUPT_GRACE_MS = 5000;

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
  // No abort signal here: the process outlives the turn. Each turn handles its own signal.
  const proc = spawnStream(path, ["app-server"], { cwd: first.selection.cwd, env: first.env });
  proc.hold(false);
  let threadId: string | undefined;
  let model: string | undefined;
  let exited = false;
  let closed = false;
  let current: Turn | undefined;

  const finish = (t: Turn, events: FunnelEvent[]) => {
    if (t.finished) return;
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
      else for (const e of r.events) t.out.push(e);
    },
    request(id, method, params) {
      const req: ServerRequest = { id, method, params: params ?? {} };
      const t = current;
      const request = t && !t.finished ? toApprovalRequest(req, t.translator.items) : undefined;
      // Nobody can answer between turns.
      if (!t || !request) {
        rpc.respond(id, toReply(req, "deny"));
        return;
      }
      void decideApproval(req, request, t.input, (e) => t.out.push(e)).then((d) => rpc.respond(id, toReply(req, d)));
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
    const settings = await threadSettings(path, first);
    const started = first.sessionId
      ? await rpc.request("thread/resume", { threadId: first.sessionId, ...settings })
      : await rpc.request("thread/start", { ...settings, ...start });
    threadId = started.thread.id as string;
    model = started.model;
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
      translator: new Translator(threadId ?? ""),
      started,
      setTurnId: (id) => {
        t.turnId ??= id;
        setTurnId(t.turnId);
      },
      ended,
      end,
      finished: false,
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
        t.translator = new Translator(id);
        t.out.push({ type: "session", sessionId: id, model });
        const res = await rpc.request("turn/start", turnParams(input, id));
        if (res?.turn?.id) t.setTurnId(res.turn.id);
      } catch (e) {
        finish(t, [{ type: "error", message: e instanceof Error ? e.message : String(e), code: "cli-failed" }]);
      }
    })();

    let terminal = false;
    try {
      for await (const e of t.out) {
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
