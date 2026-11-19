import type { FunnelEvent } from "../types.js";

type ToolStart = Extract<FunnelEvent, { type: "tool.start" }>;

/**
 * A second line behind the hook or the deny rules that keep tools off at access `none`. Those rules are the CLI's own
 * and a CLI can load them wrong, skip them for one kind of call, or change how it reads them. When a tool that
 * should have been refused is seen to finish without an error, the rules did not apply, and the run must stop.
 *
 * `forbidden` says which calls must never finish at `none`. A call that ends with an error was refused, which is what
 * is meant to happen.
 */
export function createNoneGuard(forbidden: (start: ToolStart) => boolean) {
  const started = new Map<string, ToolStart>();
  return {
    /** The reason to stop the run, or undefined. Give it every event of the run in order. */
    check(e: FunnelEvent): string | undefined {
      if (e.type === "tool.start" && !e.parentId) started.set(e.id, e);
      if (e.type !== "tool.end" || e.parentId || e.error !== undefined) return undefined;
      const call = started.get(e.id);
      if (!call || !forbidden(call)) return undefined;
      return `The tool "${call.name}" ran at access "none", where every tool is refused. The rules that keep tools off did not apply, so the run was stopped.`;
    },
  };
}

/** Cursor Agent's tools that touch the machine or the network, as `tool.start` names them. Glob and grep only see the empty folder `none` runs in. */
const CURSOR_FORBIDDEN = new Set(["shell", "read", "edit", "write", "delete", "mcp", "task", "webFetch", "webSearch", "fetch"]);

/** For Cursor Agent: a call to one of its tools that reach the machine must never finish at `none`. */
export const cursorNoneGuard = () => createNoneGuard((start) => CURSOR_FORBIDDEN.has(start.name));
