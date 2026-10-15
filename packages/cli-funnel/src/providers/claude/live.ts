import { FunnelError, type FunnelEvent, type LiveSession, type RunInput } from "../../types.js";
import { Channel } from "../../util/channel.js";
import { needsArgFile, writeArgFile } from "../../util/argfile.js";
import { spawnStream, type Streamed } from "../../util/process.js";
import { findBinary } from "../base.js";
import { BIN, answerControlRequest, buildArgs, userContent } from "./index.js";
import { parseClaudeMessage } from "./parser.js";

/**
 * Claude Code with `--input-format stream-json` reads user messages from stdin until stdin closes, and answers each
 * one with a turn that ends in `result`. A live session keeps stdin open between turns.
 *
 * A user message written while a turn runs is not added to that turn: Claude Code queues it and answers it as a turn of
 * its own, with a second `result`. So this session has no `steer`.
 */
export async function openClaudeSession(first: RunInput): Promise<LiveSession> {
  const bin = findBinary(BIN);
  if (!bin) throw new FunnelError("Claude Code is not installed.", "not-installed");
  if (first.selection.access === "supervised" && !first.onApproval) {
    throw new FunnelError('Access "supervised" needs an onApproval handler.', "invalid-selection");
  }
  // A long system prompt would hit the argv size limit, so it goes through a private temp file. The CLI reads it at
  // startup; the file is removed when the first turn ends.
  const systemFile = first.system && needsArgFile(first.system) ? await writeArgFile("system-prompt.txt", first.system) : undefined;
  let proc: Streamed;
  try {
    // No abort signal here: the process outlives the turn. Each turn handles its own signal.
    proc = spawnStream(bin, buildArgs(first, systemFile?.path), { cwd: first.selection.cwd, env: first.env, closeStdin: false });
  } catch (err) {
    await systemFile?.remove();
    throw err;
  }
  void proc.exited.then(() => systemFile?.remove());
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

    let finished = false;
    try {
      if (!closed) proc.write(JSON.stringify({ type: "user", message: { role: "user", content: userContent(input) } }));
      for await (const raw of lines) {
        const msg = raw as Record<string, any>;
        if (msg.type === "control_request") {
          yield* answerControlRequest(proc, msg, input);
          continue;
        }
        for (const e of parseClaudeMessage(raw)) {
          if (e.type === "session") sessionId = e.sessionId;
          // Set before yielding: a consumer that stops at `done` never comes back to this loop.
          if (e.type === "done" || e.type === "error") finished = true;
          yield e;
        }
        if (msg.type === "result") break;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (current === lines) current = undefined;
      // A turn that did not reach its result leaves the process mid-answer. It cannot take another turn.
      if (!finished) stop();
      proc.hold(false);
      await systemFile?.remove();
    }
    if (finished) return;
    await proc.exited;
    if (aborted || closed) yield { type: "done", text: "", finishReason: "cancelled" };
    else yield { type: "error", message: proc.stderr().trim() || "Claude Code exited without a result.", code: "cli-failed" };
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
