import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRunFolder, type RunFolder } from "./providers/base.js";
import type { FunnelEvent, RunEventRecord, RunInput } from "./types.js";
import { redact } from "./util/redact.js";

export type RunEventHandler = (record: RunEventRecord) => unknown;

/**
 * Passes every event of a run to `onEvent` and yields it on unchanged. The handler is called without being awaited.
 * A handler that throws, or returns a rejected promise, is ignored. A run that fails without an `error` event
 * (a bad selection, a CLI that is not installed) gets one, so every run ends with a `done` or an `error` record.
 */
export async function* observeRun(onEvent: RunEventHandler, input: RunInput, source: AsyncIterable<FunnelEvent>): AsyncGenerator<FunnelEvent> {
  const runId = input.runId ?? `run_${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const emit = (event: FunnelEvent) => {
    try {
      const out = onEvent({
        runId,
        provider: input.selection.provider,
        model: input.selection.model,
        selection: input.selection,
        prompt: input.prompt,
        startedAt,
        time: Date.now(),
        event,
      });
      if (out instanceof Promise) out.catch(() => {});
    } catch {
      /* a broken observer must not break the run */
    }
  };
  let ended = false;
  try {
    for await (const event of source) {
      if (event.type === "done" || event.type === "error") ended = true;
      emit(event);
      yield event;
    }
  } catch (err) {
    if (!ended) emit({ type: "error", message: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code });
    throw err;
  }
}

export interface JsonlRunLogOptions {
  /** Add `prompt` and `text` to each line. Off by default. */
  content?: boolean;
  /** Strings to mask wherever they would appear, such as the server token and API keys. Short ones are ignored. */
  secrets?: (string | undefined)[];
  /** Called when a line cannot be written. The run is not affected. Default: one line on stderr per distinct message. */
  onError?: (err: Error) => void;
}

/** Runs that never end, such as a consumer that stopped reading, would pile up. The oldest go first. */
const MAX_OPEN_RUNS = 1000;

/**
 * An `onEvent` handler that appends one JSON line per finished run to `file`. Pass it to `createFunnel({ onEvent })`.
 *
 * A line has: `time`, `runId`, `provider`, `model`, `effort`, `fast`, `contextWindow`, `access`, `cwd`, `sessionId`,
 * `startedAt`, `durationMs`, `finishReason`, `usage`, `toolCalls`, `tools` (calls per tool name), `deniedActions`
 * and, for a failed run, `error` with `message` and `code`. Tool inputs and outputs are never logged.
 * `prompt` and `text` are added only with `content: true`.
 */
export function jsonlRunLog(file: string, options: JsonlRunLogOptions = {}): RunEventHandler {
  const runs = new Map<string, RunFolder>();
  const reported = new Set<string>();
  let ready = false;
  const report = (err: Error) => {
    if (options.onError) return options.onError(err);
    if (reported.has(err.message)) return;
    reported.add(err.message);
    process.stderr.write(`cli-funnel run log: ${err.message}\n`);
  };
  const write = (line: Record<string, unknown>) => {
    try {
      if (!ready) {
        mkdirSync(dirname(file), { recursive: true });
        ready = true;
      }
      appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch (err) {
      report(err instanceof Error ? err : new Error(String(err)));
    }
  };

  return (r) => {
    const e = r.event;
    let folder = runs.get(r.runId);
    if (!folder) {
      // The folder reads only the selection and the response schema, which a log record does not carry.
      folder = createRunFolder({ selection: r.selection, prompt: r.prompt });
      runs.set(r.runId, folder);
      if (runs.size > MAX_OPEN_RUNS) runs.delete(runs.keys().next().value!);
    }
    // `add` throws on an error event. The log wants a line for it instead.
    if (e.type !== "error" && (e.type !== "text.delta" || options.content)) folder.add(e);
    if (e.type === "done" || e.type === "error") {
      runs.delete(r.runId);
      const run = folder.finish();
      const tools: Record<string, number> = {};
      for (const call of run.toolCalls) tools[call.name] = (tools[call.name] ?? 0) + 1;
      const s = r.selection;
      write({
        time: new Date(r.time).toISOString(),
        runId: r.runId,
        provider: r.provider,
        model: run.model,
        effort: s.effort,
        fast: s.fast,
        contextWindow: s.contextWindow,
        access: s.access,
        cwd: s.cwd,
        sessionId: run.sessionId,
        startedAt: new Date(r.startedAt).toISOString(),
        durationMs: r.time - r.startedAt,
        finishReason: e.type === "done" ? e.finishReason : "error",
        usage: run.usage,
        toolCalls: run.toolCalls.length,
        tools: run.toolCalls.length ? tools : undefined,
        deniedActions: run.deniedActions.map((a) => redact(a, options.secrets)),
        error: e.type === "error" ? { message: redact(e.message, options.secrets), code: e.code } : undefined,
        ...(options.content
          ? { prompt: redact(r.prompt, options.secrets), text: redact(run.text, options.secrets) }
          : {}),
      });
    }
  };
}
