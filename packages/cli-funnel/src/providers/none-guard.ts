import type { FunnelEvent } from "../types.js";

type ToolStart = Extract<FunnelEvent, { type: "tool.start" }>;

/**
 * A second line behind the hook or the deny rules that keep tools off at access `none`. Those rules are the CLI's own
 * and a CLI can load them wrong, skip them for one kind of call, or change how it reads them. When a tool that
 * should have been refused is seen to finish without an error, the rules did not apply, and the run must stop.
 *
 * `forbidden` says which calls must never finish at `none`. A call that ends in a refusal is what is meant to happen.
 * A call that fails for another reason is not: a tool that ran and broke has still run. `refusal` tells the two apart
 * by the text of the error, which each provider's mapper writes only for a refusal by the rules or by the permission
 * answer. A subagent's calls count like any other, so those with a `parentId` are checked too. Make one guard per turn:
 * it holds each call from its start to its end and no longer.
 */
export function createNoneGuard(forbidden: (start: ToolStart) => boolean, refusal: RegExp = /^denied: /) {
  const started = new Map<string, ToolStart>();
  const stopped = (name: string, what: string) =>
    `The tool "${name}" ${what} at access "none", where every tool is refused. The rules that keep tools off did not apply, so the run was stopped.`;
  return {
    /** The reason to stop the run, or undefined. Give it every event of the run in order. */
    check(e: FunnelEvent): string | undefined {
      if (e.type === "tool.start") started.set(e.id, e);
      if (e.type !== "tool.end") return undefined;
      const call = started.get(e.id);
      started.delete(e.id);
      if (!call || !forbidden(call)) return undefined;
      if (e.error === undefined) return stopped(call.name, "ran");
      return refusal.test(e.error) ? undefined : stopped(call.name, "failed without being refused, so it may have run");
    },
    /** For the end of a turn: a forbidden call that started and never ended may have run. */
    unfinished(): string | undefined {
      for (const call of started.values()) if (forbidden(call)) return stopped(call.name, "started and never ended, so it may have run");
      return undefined;
    },
    /** How many calls have started and not ended. */
    pending: () => started.size,
  };
}

/** What agy's mapper writes for a call the hook or the permission answer refused. */
export const AGY_REFUSAL = /^denied: (denied by pre-tool hook|denied permission)/i;

/**
 * Cursor Agent's tools that can complete at `none` without touching the machine or the network: glob and grep see only
 * the empty folder `none` runs in, and the rest ask or plan. A normal answer at `none` calls `read`, which the deny
 * rules refuse with an error, and nothing else. Any other tool that completes, a name this list does not know included,
 * means the rules did not apply.
 */
const CURSOR_HARMLESS = new Set(["glob", "grep", "getMcpTools", "updateTodos", "createPlan", "askQuestion"]);

/** For Cursor Agent: only a tool of the harmless list may complete without an error at `none`. */
export const cursorNoneGuard = () => createNoneGuard((start) => !CURSOR_HARMLESS.has(start.name));
