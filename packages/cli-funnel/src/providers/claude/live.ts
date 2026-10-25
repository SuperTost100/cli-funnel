import { FunnelError, type FunnelEvent, type LiveSession, type RunInput } from "../../types.js";
import { Channel } from "../../util/channel.js";
import { exitedEarly } from "../base.js";
import { claudeTurn, forwardsSubagents, launchClaude, userMessage } from "./index.js";
import { newClaudeTrack } from "./parser.js";

/**
 * Claude Code with `--input-format stream-json` reads user messages from stdin until stdin closes, and answers each
 * one with a turn that ends in `result`. A live session keeps stdin open between turns.
 *
 * A user message written while a turn runs is not added to that turn: Claude Code queues it and answers it as a turn of
 * its own, with a second `result`. So this session has no `steer`.
 */
export async function openClaudeSession(first: RunInput): Promise<LiveSession> {
  // No abort signal here: the process outlives the turn. Each turn handles its own signal. The reply to a schema
  // `initialize` request arrives before any turn reads, so it is dropped with the other lines between turns.
  const { proc, removeFiles } = await launchClaude(first);
  void proc.exited.then(removeFiles);
  const forward = forwardsSubagents(first);
  // The task list and the edit calls belong to the process, which spans the turns.
  const track = newClaudeTrack();
  proc.hold(false);
  let sessionId: string | undefined;
  let exited = false;
  let closed = false;
  // The channel of the running turn. Lines that arrive between turns have no reader and are dropped.
  let current: Channel<unknown> | undefined;

  void (async () => {
    try {
      for await (const raw of proc.lines) current?.push(raw);
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

    const state = { finished: false };
    try {
      if (!closed) proc.write(userMessage(input));
      for await (const e of claudeTurn(proc, lines, input, forward, state, track)) {
        if (e.type === "session") sessionId = e.sessionId;
        yield e;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (current === lines) current = undefined;
      // A turn that did not reach its result leaves the process mid-answer. It cannot take another turn.
      if (!state.finished) stop();
      proc.hold(false);
      await removeFiles();
    }
    if (!state.finished) yield await exitedEarly(proc, "Claude Code", () => aborted || closed);
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
      if (current) return stop();
      // Idle: closing stdin lets Claude Code exit on its own and finish saving the session. Stop it if it does not.
      closed = true;
      proc.closeStdin();
      setTimeout(() => proc.kill(), 2000).unref();
    },
  };
}
