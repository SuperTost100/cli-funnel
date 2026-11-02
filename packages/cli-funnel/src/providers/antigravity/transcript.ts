import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import type { FunnelEvent, RunInput } from "../../types.js";
import { mask, runSecrets } from "../../util/redact.js";

type Json = Record<string, any>;

/** Which subagent work to turn into events. Both default to off. */
export interface ForwardSubagents {
  text?: boolean;
  tools?: boolean;
}

/** A subagent that an `invoke_subagent` call started, as the stream names it. */
export interface SubagentStart {
  /** The id of the `invoke_subagent` tool call, the same as its `tool.start`. */
  parentId: string;
  /** The subagent's own conversation id. */
  conversationId: string;
  /** Its `type_name`, such as `self`. */
  agent?: string;
}

/** Conversation ids are UUIDs. Anything else could leave the brain folder, so it is never used in a path. */
const CONVERSATION_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * The subagents a stream line reports as started: the last `step_update` of an `invoke_subagent` call, which has type
 * `subagent` and lists each subagent with its conversation id. Other lines give none.
 */
export function subagentStarts(line: unknown): SubagentStart[] {
  const s = (line as Json)?.event === "step_update" ? ((line as Json).step_update as Json) : undefined;
  if (!s || s.step_type !== "subagent" || s.state !== "DONE" || !Array.isArray(s.subagent_info?.subagents)) return [];
  const parentId = `${s.conversation_id}:${s.step_index}`;
  return s.subagent_info.subagents.flatMap((a: Json): SubagentStart[] =>
    typeof a?.conversation_id === "string" && CONVERSATION_ID.test(a.conversation_id)
      ? [{ parentId, conversationId: a.conversation_id, ...(typeof a.type_name === "string" && a.type_name ? { agent: a.type_name } : {}) }]
      : [],
  );
}

/** Where agy writes a conversation's transcript, under the brain folder of the run. */
export const transcriptPath = (brainDir: string, conversationId: string): string =>
  join(brainDir, conversationId, ".system_generated", "logs", "transcript.jsonl");

/** What the transcript parser remembers about one subagent between lines. */
export interface TranscriptState {
  start: SubagentStart;
  /** Steps already turned into events, by `step_index`, so a line read twice gives nothing new. */
  seen: Set<number>;
  /** Tool calls waiting for their result step, oldest first. */
  pending: string[];
}

export const newTranscript = (start: SubagentStart): TranscriptState => ({ start, seen: new Set(), pending: [] });

/** Tool arguments in `transcript.jsonl` are JSON written as strings, such as `"\"ls -la\""`. Each one is decoded when it parses. */
function decodeArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => {
      if (typeof v !== "string") return [k, v];
      try {
        return [k, JSON.parse(v)];
      } catch {
        return [k, v];
      }
    }),
  );
}

/**
 * Maps one line of a subagent's `transcript.jsonl` to events, as checked on agy 1.4.12. A `PLANNER_RESPONSE` step
 * carries the model's text (`content`) and its `tool_calls`, which have no ids, so each gets
 * `<conversation id>:<step>:<n>`. The result of each call is the next `GENERIC` step, in order. Other step types, such
 * as the `SYSTEM_MESSAGE` that holds the prompt, are skipped, and so are lines that are not steps. The parser does no I/O.
 */
export function transcriptEvents(state: TranscriptState, line: unknown, forward: ForwardSubagents): FunnelEvent[] {
  const step = line as Json;
  if (!step || typeof step !== "object" || typeof step.step_index !== "number" || state.seen.has(step.step_index)) return [];
  if (step.status !== "DONE" && step.status !== "ERROR") return [];
  state.seen.add(step.step_index);
  const { parentId, agent, conversationId } = state.start;
  const tag = { parentId, ...(agent ? { agent } : {}) };
  const events: FunnelEvent[] = [];
  if (step.type === "PLANNER_RESPONSE") {
    if (forward.text && typeof step.content === "string" && step.content) events.push({ type: "subagent.text", text: step.content, ...tag });
    (Array.isArray(step.tool_calls) ? step.tool_calls : []).forEach((call: Json, i: number) => {
      const id = `${conversationId}:${step.step_index}:${i}`;
      state.pending.push(id);
      if (forward.tools) events.push({ type: "tool.start", id, name: String(call?.name ?? "tool"), input: decodeArgs(call?.args), ...tag });
    });
    return events;
  }
  if (step.type === "GENERIC" && state.pending.length) {
    const id = state.pending.shift()!;
    const content = typeof step.content === "string" ? step.content : undefined;
    if (forward.tools) events.push(step.status === "ERROR" ? { type: "tool.end", id, error: content ?? "Tool failed.", ...tag } : { type: "tool.end", id, output: content, ...tag });
  }
  return events;
}

/** How often a running subagent's transcript is read again. */
const POLL_MS = 500;

/** Reads one subagent's transcript from where the last read stopped. A missing or unreadable file gives nothing. */
class Tail {
  private offset = 0;
  private rest = "";
  // A character split between two reads is held back until the next one.
  private readonly decoder = new StringDecoder("utf8");
  private readonly state: TranscriptState;

  constructor(
    private readonly path: string,
    start: SubagentStart,
    private readonly forward: ForwardSubagents,
  ) {
    this.state = newTranscript(start);
  }

  /** `final` also takes a last line without a line break, since nothing more is coming. */
  async read(final = false): Promise<FunnelEvent[]> {
    let text: string;
    try {
      const file = await open(this.path, "r");
      try {
        const { size } = await file.stat();
        const buf = Buffer.alloc(Math.max(0, size - this.offset));
        const { bytesRead } = buf.length ? await file.read(buf, 0, buf.length, this.offset) : { bytesRead: 0 };
        this.offset += bytesRead;
        text = this.rest + this.decoder.write(buf.subarray(0, bytesRead));
      } finally {
        await file.close();
      }
    } catch {
      // Not written yet, or not readable: the run goes on without these events.
      return [];
    }
    const lines = text.split("\n");
    // A last line without a line break may still be being written.
    this.rest = final ? "" : (lines.pop() ?? "");
    return lines.flatMap((l) => {
      try {
        return transcriptEvents(this.state, JSON.parse(l), this.forward);
      } catch {
        return [];
      }
    });
  }
}

/**
 * The transcripts of the subagents a run starts. `watch` sees each stream line and starts reading a subagent's file
 * once the `invoke_subagent` call names its conversation, from the run's own brain folder only. Reads repeat every
 * POLL_MS and set `wake`, and `take` hands over what they found. `finish` reads every file once more. The run's
 * secrets are masked in every event.
 */
export class SubagentTranscripts {
  private readonly tails: Tail[] = [];
  private buffer: FunnelEvent[] = [];
  private busy: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private readonly secrets: string[];

  constructor(
    private readonly brainDir: string,
    private readonly forward: ForwardSubagents,
    input: RunInput,
    private readonly wake: () => void,
  ) {
    this.secrets = runSecrets(input);
  }

  watch(line: unknown): void {
    const starts = subagentStarts(line);
    if (!starts.length) return;
    for (const start of starts) this.tails.push(new Tail(transcriptPath(this.brainDir, start.conversationId), start, this.forward));
    this.poll();
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), POLL_MS);
      this.timer.unref();
    }
  }

  /** Events read so far, in the order they were read. */
  take(): FunnelEvent[] {
    return this.buffer.splice(0);
  }

  /** Waits for a read in progress, reads every file once more, and returns what has not been taken yet. */
  async finish(): Promise<FunnelEvent[]> {
    this.stop();
    this.read(true);
    await this.busy;
    return this.take();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    this.read();
    void this.busy.then(() => {
      if (this.buffer.length) this.wake();
    });
  }

  /** Reads run one after another, so two reads of one file never overlap. */
  private read(final = false): void {
    this.busy = this.busy.then(async () => {
      for (const tail of this.tails) {
        for (const e of await tail.read(final)) this.buffer.push(mask(e, this.secrets) as FunnelEvent);
      }
    });
  }
}
