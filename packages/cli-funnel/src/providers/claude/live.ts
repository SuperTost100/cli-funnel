import { randomUUID } from "node:crypto";
import { FunnelError, type FunnelEvent, type LiveSession, type RunInput } from "../../types.js";
import { Channel } from "../../util/channel.js";
import { exitedEarly } from "../base.js";
import { claudeTurn, forwardsSubagents, launchClaude, userMessage, watchStderr } from "./index.js";
import { newClaudeTrack } from "./parser.js";

/**
 * The messages `steer` wrote during one funnel turn, by the uuid each was sent with. Claude Code reports each one in
 * `command_lifecycle` lines: `queued` when it arrives, `started` when a turn takes it in, then one end state
 * (`completed`, `cancelled`, `discarded` or `refused`). A message sent with priority `next` joins the running turn once
 * its tool calls finish. A message still queued when the turn ends runs after it as a turn of its own.
 */
export class Steers {
  /** Written and not yet taken into a turn. */
  private readonly queued = new Set<string>();
  /** Taken into the turn that is running, whose result has not arrived. */
  private readonly taken = new Set<string>();
  /** Set when the funnel turn has decided to end. A message written after that would start a turn nobody reads. */
  ended = false;

  add(uuid: string): void {
    this.queued.add(uuid);
  }

  /** Reads one `command_lifecycle` line. Ends other than `completed` mean the message never reaches the model. */
  lifecycle(uuid: string, state: string): void {
    if (state === "queued" || !this.queued.delete(uuid)) return;
    if (state === "started" || state === "completed") this.taken.add(uuid);
  }

  /**
   * Reads the `user_message_uuids` of a `result`, which lists the messages that turn took in. Returns true when a
   * message is still queued, so another turn follows.
   */
  result(uuids: unknown): boolean {
    if (Array.isArray(uuids)) for (const u of uuids) this.queued.delete(String(u));
    this.taken.clear();
    return this.queued.size > 0;
  }

  /** True when no message is queued and no turn that took one is still running. */
  get idle(): boolean {
    return this.queued.size === 0 && this.taken.size === 0;
  }
}

/** The `system` / `init` capability that says Claude Code reports `command_lifecycle` for messages sent with a uuid. */
const LIFECYCLE = "msg_lifecycle_v1";

/**
 * Claude Code with `--input-format stream-json` reads user messages from stdin until stdin closes, and answers each
 * one with a turn that ends in `result`. A live session keeps stdin open between turns.
 *
 * `steer` writes a user message while a turn runs, with a uuid and priority `next`. Claude Code reads it in the same
 * turn once the running tool calls finish. When the turn ends first, Claude Code answers the message in a turn of its
 * own, and the funnel turn lasts until that turn's result (see `Steers` and `claudeTurn`). `steer` is offered only when
 * the CLI reports the message lifecycle, which tells the two cases apart.
 */
export async function openClaudeSession(first: RunInput): Promise<LiveSession> {
  // No abort signal here: the process outlives the turn. Each turn handles its own signal. The reply to a schema
  // `initialize` request arrives before any turn reads, so it is dropped with the other lines between turns.
  const { proc, removeFiles } = await launchClaude(first);
  void proc.exited.then(removeFiles);
  const forward = forwardsSubagents(first);
  // The task list and the edit calls belong to the process, which spans the turns.
  const track = newClaudeTrack();
  // Listens for the life of the process: startup warnings arrive before the first turn reads, and each turn takes what is held.
  watchStderr(proc, first, track);
  proc.hold(false);
  let sessionId: string | undefined;
  let exited = false;
  let closed = false;
  let lifecycle = false;
  // The channel of the running turn. Lines that arrive between turns have no reader and are dropped.
  let current: Channel<unknown> | undefined;
  let turns = 0;
  // The running turn's steer messages, and whether its last event was reached.
  let running: { steers: Steers; state: { finished: boolean } } | undefined;

  void (async () => {
    try {
      for await (const raw of proc.lines) {
        const m = raw as Record<string, unknown>;
        if (m?.type === "system" && m.subtype === "init") lifecycle = Array.isArray(m.capabilities) && m.capabilities.includes(LIFECYCLE);
        current?.push(raw);
      }
    } catch (e) {
      current?.fail(e);
    } finally {
      exited = true;
      current?.end();
    }
  })();

  /** Stops the process now. */
  const stop = () => {
    closed = true;
    proc.closeStdin();
    proc.kill();
  };

  async function* turn(input: RunInput): AsyncGenerator<FunnelEvent> {
    if (current) throw new FunnelError("A turn is already running in this session.", "invalid-selection");
    // Warnings that arrived since the last turn ended belong to no turn, so they are dropped rather than given to this
    // one. The first turn keeps what the CLI printed at startup.
    if (turns++) track.notices.clear();
    const lines = new Channel<unknown>();
    current = lines;
    if (exited || closed) lines.end();
    proc.hold(true);
    const signal = input.signal;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    // Whether the caller stopped the turn, read before the cleanup below stops the process itself.
    let stopped = false;
    const state = { finished: false };
    const steers = new Steers();
    running = { steers, state };
    try {
      if (!closed) proc.write(userMessage(input));
      for await (const e of claudeTurn(proc, lines, input, forward, state, track, undefined, steers)) {
        if (e.type === "session") sessionId = e.sessionId;
        yield e;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (current === lines) current = undefined;
      if (running?.steers === steers) running = undefined;
      // A turn that did not reach its result leaves the process mid-answer. It cannot take another turn. Neither can one
      // that failed with a steer message still queued, since Claude Code would answer it as the next turn.
      stopped = aborted || closed;
      if (!state.finished || !steers.idle) stop();
      proc.hold(false);
      await removeFiles();
    }
    if (!state.finished) yield await exitedEarly(proc, "Claude Code", () => stopped);
  }

  async function steer(text: string): Promise<void> {
    const t = running;
    if (!t || t.steers.ended || t.state.finished || exited || closed) throw new FunnelError("No turn is running in this session.", "invalid-selection");
    const uuid = randomUUID();
    t.steers.add(uuid);
    proc.write(JSON.stringify({ type: "user", uuid, priority: "next", message: { role: "user", content: text } }));
  }

  return {
    get sessionId() {
      return sessionId;
    },
    get alive() {
      return !exited && !closed;
    },
    turn,
    get steer() {
      return lifecycle ? steer : undefined;
    },
    close() {
      if (closed) return;
      if (current) return stop();
      // Idle: closing stdin lets Claude Code exit on its own and finish saving the session. Stop it if it does not.
      closed = true;
      proc.closeStdin();
      setTimeout(() => proc.kill(), 2000).unref();
    },
  };
}
