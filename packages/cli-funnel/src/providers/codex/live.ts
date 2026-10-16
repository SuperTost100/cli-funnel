import { FunnelError, type FunnelEvent, type LiveSession, type RunInput } from "../../types.js";
import { Channel } from "../../util/channel.js";
import { spawnStream } from "../../util/process.js";
import { findBinary } from "../base.js";
import { toApprovalRequest, toReply, type ServerRequest } from "./approvals.js";
import { Translator } from "./events.js";
import { BINARY, INITIALIZE_PARAMS, decideApproval, threadSettings, threadStartParams, turnParams } from "./index.js";
import { RpcClient } from "./rpc.js";

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

/**
 * One `codex app-server` and one thread, kept across turns. Each turn is a `turn/start` on the same thread.
 * `steer` sends `turn/steer`, which adds a user message to the running turn.
 */
export async function openCodexSession(first: RunInput): Promise<LiveSession> {
  const path = findBinary(BINARY);
  if (!path) throw new FunnelError("codex is not installed.", "not-installed");
  // Refuses options that would widen access before a process starts.
  const start = threadStartParams(first);
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
      // Nobody can answer between turns.
      if (!t || t.finished || !toApprovalRequest(req, t.translator.items)) {
        rpc.respond(id, toReply(req, "deny"));
        return;
      }
      void decideApproval(req, t.input, t.translator.items, (e) => t.out.push(e)).then((d) => rpc.respond(id, toReply(req, d)));
    },
    closed() {
      exited = true;
      const t = current;
      if (!t) return;
      const err = proc.stderr().trim().split("\n").slice(-3).join(" ");
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
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      if (t.finished) return;
      if (threadId && t.turnId) {
        rpc.request("turn/interrupt", { threadId, turnId: t.turnId }).catch(() => {});
        setTimeout(() => finish(t, [{ type: "done", text: "", finishReason: "cancelled" }]), 5000).unref();
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
      // An aborted turn, or one the consumer left before it ended, leaves the thread in an unknown state.
      if (aborted || !terminal) stop();
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
