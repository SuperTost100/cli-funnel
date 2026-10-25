import { isAbsolute, posix, win32 } from "node:path";
import type { EffortOption, FunnelEvent, ModelInfo, PlanStep, Usage } from "../../types.js";

const EFFORTS = ["low", "medium", "high", "max"];
const EFFORT_RE = /^(.+)-(low|medium|high|max)$/;

/** Parses `agy models` output (`id<TAB>Name` lines). Ids that differ only by an effort suffix become one model. */
export function parseModels(text: string): ModelInfo[] {
  const rows: { id: string; name: string; base: string; effort?: string }[] = [];
  for (const line of text.split("\n")) {
    const [rawId = "", rawName = ""] = line.split("\t");
    const id = rawId.trim();
    if (!id || id.includes(" ") || !rawName.trim()) continue;
    const m = EFFORT_RE.exec(id);
    rows.push({ id, name: rawName.trim(), base: m?.[1] ?? id, effort: m?.[2] });
  }
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r.base, [...(groups.get(r.base) ?? []), r]);
  const out: ModelInfo[] = [];
  for (const [base, members] of groups) {
    const first = members[0];
    if (!first) continue;
    const base0 = { provider: "antigravity" as const, contextWindows: [], fast: false, source: "cli" as const };
    if (members.length < 2 || members.some((x) => !x.effort)) {
      for (const r of members) out.push({ ...base0, id: r.id, name: r.name, efforts: [] });
      continue;
    }
    const efforts = members.map((x) => x.effort as string).sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
    out.push({
      ...base0,
      id: base,
      name: first.name.replace(/\s*\([^)]*\)\s*$/, ""),
      efforts: efforts.map((id): EffortOption => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) })),
      defaultEffort: efforts.includes("high") ? "high" : efforts[0],
    });
  }
  return out;
}

type Json = Record<string, any>;

function toUsage(u: Json | undefined): Usage | undefined {
  if (!u) return undefined;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: u.cache_read_tokens || undefined,
    reasoningTokens: u.thinking_tokens || undefined,
    totalTokens: u.total_tokens ?? input + output,
  };
}

/** Tools that write a whole file. The file may or may not exist before. */
const WRITE_TOOLS = new Set(["write_file", "write_to_file"]);

/** Tools that change part of a file. The file has to exist. */
const EDIT_TOOLS = new Set(["edit_file", "replace_file_content", "multi_replace_file_content"]);

/** The parameter that holds the target path. 1.4 uses `Path`, 1.3 and older used `TargetFile`. */
const PATH_KEYS = ["Path", "TargetFile", "AbsolutePath", "path"];

const DENIED_RE = /denied by pre-tool hook|denied permission|permission check failed/i;

/** An absolute path as is, a relative one resolved against `cwd`, or undefined when there is no `cwd` to resolve it against. */
function absolute(path: string, cwd: string | undefined): string | undefined {
  if (isAbsolute(path) || win32.isAbsolute(path)) return path;
  if (!cwd) return undefined;
  return win32.isAbsolute(cwd) && !cwd.startsWith("/") ? win32.resolve(cwd, path) : posix.resolve(cwd, path);
}

/**
 * The paths a plain `rm` command removes, or undefined for anything else. agy has no delete tool, so the model removes
 * files with the shell. Only a command with no quotes, globs, variables, pipes or chaining counts: the paths are then
 * exactly the words, and `rm` is the whole command. Relative paths resolve against `cwd`.
 */
export function parseRm(command: string, cwd: string | undefined): string[] | undefined {
  const line = command.trim();
  if (/[;&|<>()$`\\*?[\]{}~"'!#\n]/.test(line)) return undefined;
  const [cmd, ...words] = line.split(/\s+/);
  if (cmd !== "rm") return undefined;
  const paths = words.filter((w) => w !== "--" && !/^-[A-Za-z]+$/.test(w));
  const resolved = paths.map((w) => (w.startsWith("-") ? undefined : absolute(w, cwd)));
  return paths.length > 0 && resolved.every((p) => p !== undefined) ? (resolved as string[]) : undefined;
}

/**
 * The steps of a `task.md` checklist: `- [ ]` pending, `- [/]` in progress, `- [x]` done. An item with nested items is a
 * heading for them, so only the nested ones become steps. Lines that are not checklist items are ignored.
 */
export function parseTaskList(markdown: string): PlanStep[] {
  const items: { indent: number; step: PlanStep }[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^(\s*)[-*]\s+\[([ xX/])\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = (m[3] ?? "").replace(/\*\*(.+?)\*\*/g, "$1").trim();
    const mark = m[2];
    items.push({ indent: (m[1] ?? "").replace(/\t/g, "    ").length, step: { text, status: mark === "/" ? "in_progress" : mark === " " ? "pending" : "done" } });
  }
  return items.filter((it, i) => (items[i + 1]?.indent ?? 0) <= it.indent).map((it) => it.step);
}

/** What the mapper may ask the outside world. The mapper stays pure: the caller does the file system work. */
export interface MapperOptions {
  /** Set to `"api-key"` when the run was given a key, so the `session` event says so. */
  auth?: "api-key";
  /**
   * Whether the file at `path` was created after the run started, or undefined when that cannot be told (the file is gone,
   * or the file system keeps no creation time). agy sends a tool step only after the tool has run, so "does it exist" no
   * longer answers whether a write added the file. Called when a `write_file` finishes. An unknown answer counts as `add`.
   */
  createdInRun?: (path: string) => boolean | undefined;
  /**
   * The folder agy keeps conversation artifacts in (`.../antigravity-cli/brain`). A finished write to
   * `<brainDir>/<conversation>/task.md` is the agent's task list: the mapper asks `readText` for it and emits a `plan`.
   * Without both there are no plans. Other writes into that folder are agy's own files and produce no `file.change`.
   */
  brainDir?: string;
  readText?: (path: string) => string | undefined;
}

const slashes = (p: string) => p.replace(/\\/g, "/");

/** Stateful mapper from one `agy --output-format stream-json` line to zero or more FunnelEvents. */
export function createMapper(options: MapperOptions = {}) {
  const started = new Set<string>();
  // Files a write tool already wrote in this run, so a second write to one is an update, not another add.
  const written = new Set<string>();
  let deniedSeen = 0;
  // Hook denials never show up in `denied_actions`, so they are counted apart.
  let hookDenied = 0;
  let finished = false;
  let cwd: string | undefined;
  let lastPlan = "";

  const brain = options.brainDir ? slashes(options.brainDir).replace(/\/+$/, "") : undefined;
  const inBrain = (path: string) => brain !== undefined && slashes(path).startsWith(`${brain}/`);

  function targetOf(params: Json | undefined): string | undefined {
    const raw = PATH_KEYS.map((k) => params?.[k]).find((v): v is string => typeof v === "string" && v.length > 0);
    return raw === undefined ? undefined : absolute(raw, cwd);
  }

  function rmPaths(params: Json | undefined): string[] | undefined {
    const dir = typeof params?.Cwd === "string" ? absolute(params.Cwd, cwd) : cwd;
    return parseRm(String(params?.CommandLine ?? ""), dir);
  }

  /** A `plan` for a finished write to the conversation's task list, when it changed the list. */
  function planFrom(conversation: string, path: string): FunnelEvent[] {
    if (!brain || !options.readText || slashes(path) !== `${brain}/${conversation}/task.md`) return [];
    const text = options.readText(path);
    const steps = text ? parseTaskList(text) : [];
    const key = JSON.stringify(steps);
    if (!steps.length || key === lastPlan) return [];
    lastPlan = key;
    return [{ type: "plan", steps }];
  }

  /** The `file.change` events of a finished tool step. `status` says whether the step ran, failed or was refused. */
  function changes(s: Json, id: string, name: string, status: "done" | "failed" | "declined"): FunnelEvent[] {
    const params = s.tool_info?.parameters as Json | undefined;
    if (name === "run_command") {
      const paths = rmPaths(params);
      if (!paths) return [];
      // A denied command has no output at all. One that ran starts with its exit code.
      const output = s.tool_info?.output;
      const exit = typeof output === "string" ? /^Command exited with code (\d+)/.exec(output) : null;
      const result = status !== "done" ? status : exit ? (exit[1] === "0" ? "done" : "failed") : "declined";
      // shortcut: `rm -f` of a missing file reports a delete too, because agy's step does not say what was there. Upgrade when it does.
      if (result === "done") for (const path of paths) written.delete(path);
      return paths.map((path): FunnelEvent => ({ type: "file.change", id, path, kind: "delete", status: result }));
    }
    const isWrite = WRITE_TOOLS.has(name);
    if (!isWrite && !EDIT_TOOLS.has(name)) return [];
    const path = targetOf(params);
    if (!path) return [];
    if (inBrain(path)) return status === "done" ? planFrom(String(s.conversation_id), path) : [];
    // A first write to a file this run made is an add. A rewrite of a file that was there before the run is an update.
    const kind = isWrite && !written.has(path) && (options.createdInRun?.(path) ?? true) ? "add" : "update";
    if (status === "done") written.add(path);
    return [{ type: "file.change", id, path, kind, status }];
  }

  return {
    get finished() {
      return finished;
    },
    map(line: unknown): FunnelEvent[] {
      const o = line as Json;
      if (!o || typeof o !== "object") return [];
      if (o.event === "init") {
        const id = o.conversation_id;
        if (typeof o.init?.cwd === "string") cwd = o.init.cwd;
        return id ? [{ type: "session", sessionId: id, model: o.init?.model, ...(options.auth && { auth: options.auth }) }] : [];
      }
      if (o.event === "step_update") {
        const s = o.step_update as Json;
        if (s.step_type === "agent_response") {
          return s.text_delta ? [{ type: "text.delta", text: s.text_delta }] : [];
        }
        if (s.step_type !== "tool") return [];
        const id = `${s.conversation_id}:${s.step_index}`;
        const name = s.tool_name ?? s.tool_info?.name ?? "tool";
        const events: FunnelEvent[] = [];
        if (!started.has(id)) {
          started.add(id);
          events.push({ type: "tool.start", id, name, input: s.tool_info?.parameters });
        }
        if (s.state === "DONE") {
          events.push({ type: "tool.end", id });
          events.push(...changes(s, id, name, "done"));
        }
        if (s.state === "ERROR") {
          const msg = String(s.tool_info?.error?.message ?? "tool failed").split("\n")[0] ?? "tool failed";
          const byHook = /denied by pre-tool hook/i.test(msg);
          const denied = byHook || DENIED_RE.test(msg);
          if (byHook) hookDenied++;
          else if (denied) deniedSeen++;
          events.push({ type: "tool.end", id, error: denied ? `denied: ${msg}` : msg });
          events.push(...changes(s, id, name, denied ? "declined" : "failed"));
        }
        return events;
      }
      if (o.event === "result") {
        finished = true;
        const r = o.result as Json;
        if (r.status === "ERROR" || r.error) {
          return [{ type: "error", message: String(r.error ?? "Antigravity run failed."), code: "cli-failed" }];
        }
        const events: FunnelEvent[] = [];
        const denied: Json[] = r.denied_actions ?? [];
        denied.slice(deniedSeen).forEach((d, i) => {
          const id = `denied:${i}`;
          const name = d.display_name ?? d.action;
          events.push({ type: "tool.start", id, name });
          events.push({ type: "tool.end", id, error: `denied: ${d.action} needs permission that headless mode cannot ask for` });
        });
        const usage = toUsage(r.usage);
        if (usage) events.push({ type: "usage", usage });
        if (r.structured_output !== undefined) events.push({ type: "structured", data: r.structured_output });
        const text = r.response ?? "";
        events.push({ type: "done", text, finishReason: (denied.length || hookDenied) && !text.trim() ? "denied" : "stop" });
        return events;
      }
      return [];
    },
  };
}
