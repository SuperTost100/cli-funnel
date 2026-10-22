import { FunnelError, type AccessLevel, type FunnelEvent, type LiveSession, type Provider, type ProviderId, type RunInput, type Selection } from "./types.js";

export interface SessionOptions {
  /** Keep Claude Code and Codex processes alive between turns of a session. Default false: one process per turn. */
  keepAlive?: boolean;
  /** Close a live session after this many milliseconds without a turn. Default 10 minutes. */
  idleMs?: number;
  /** Most live sessions at once. When there are more, the least recently used idle one closes. Default 8. */
  max?: number;
}

/** One live session, as `funnel.sessions()` lists it. */
export interface LiveSessionInfo {
  provider: ProviderId;
  sessionId: string;
  model: string;
  cwd?: string;
  access?: AccessLevel;
  /** True while a turn runs. */
  busy: boolean;
  /** True when `funnel.steer()` works for this session. */
  steer: boolean;
  /** When the last turn started or ended, in ms since the epoch. */
  lastUsed: number;
}

interface Entry {
  provider: ProviderId;
  live: LiveSession;
  /** What the process was started with. A turn that asks for something else gets a new process. */
  fingerprint: string;
  /** The selection the process was started with. The whole input is not kept: it can hold attachments and closures. */
  selection: Selection;
  key?: string;
  busy: boolean;
  lastUsed: number;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_MAX = 8;

/** Everything a CLI process is started with. Two turns with the same fingerprint can share a process. */
export function fingerprint(input: RunInput): string {
  const s = input.selection;
  return JSON.stringify([
    s.provider,
    s.model,
    s.effort ?? null,
    s.contextWindow ?? null,
    s.fast ?? false,
    s.cwd ?? null,
    s.access ?? null,
    input.system ?? null,
    input.responseSchema ?? null,
    Object.entries(input.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    Boolean(input.onApproval),
    // Flags such as --add-dir are fixed when the process starts, so other options need another process.
    // `forkSession` is left out: it only decides how the first turn starts, and a fork is never reused (see `forks`).
    withoutFork((input.providerOptions as Record<string, unknown> | undefined)?.[s.provider]),
  ]);
}

function withoutFork(options: unknown): unknown {
  if (typeof options !== "object" || options === null) return options ?? null;
  const { forkSession: _, ...rest } = options as Record<string, unknown>;
  return Object.keys(rest).length ? rest : null;
}

/** True when the turn asks to continue its session in a new one. The live process of the old session has to stay as it is. */
const forks = (input: RunInput): boolean => (input.providerOptions as Record<string, { forkSession?: unknown } | undefined> | undefined)?.[input.selection.provider]?.forkSession === true;

const keyOf = (provider: ProviderId, sessionId: string) => `${provider}\u0000${sessionId}`;

/**
 * Live CLI processes, one per session, reused across turns. A turn with a `sessionId` that has a live, idle process
 * started with the same settings runs on it. Any other turn starts a new process, which resumes `sessionId` if set.
 */
export class SessionPool {
  private readonly entries = new Set<Entry>();
  private readonly byKey = new Map<string, Entry>();
  private readonly idleMs: number;
  private readonly max: number;

  constructor(options: SessionOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.max = Math.max(1, options.max ?? DEFAULT_MAX);
  }

  /** Runs one turn. Providers without `openSession` run as usual. */
  async *run(p: Provider, input: RunInput): AsyncGenerator<FunnelEvent> {
    if (!p.openSession) {
      yield* p.run(input);
      return;
    }
    const fp = fingerprint(input);
    // A fork starts a process of its own and leaves the live process of the session it forks from alone.
    let entry = input.sessionId && !forks(input) ? this.byKey.get(keyOf(p.id, input.sessionId)) : undefined;
    // A second turn on a session that is still answering gets its own process, as it would without the pool.
    if (entry?.busy) {
      yield* p.run(input);
      return;
    }
    if (entry && (!entry.live.alive || entry.fingerprint !== fp)) {
      this.drop(entry);
      entry = undefined;
    }
    if (!entry) {
      entry = { provider: p.id, live: await p.openSession(input), fingerprint: fp, selection: input.selection, busy: false, lastUsed: Date.now() };
      this.entries.add(entry);
    }
    entry.busy = true;
    entry.lastUsed = Date.now();
    clearTimeout(entry.timer);

    let terminal = false;
    try {
      for await (const e of entry.live.turn(input)) {
        if (e.type === "session") this.register(entry, e.sessionId);
        if (e.type === "done" || e.type === "error") terminal = true;
        yield e;
      }
    } finally {
      entry.busy = false;
      entry.lastUsed = Date.now();
      // An aborted turn is not dropped here. The live session decides: Claude Code stops its process, Codex keeps its
      // app-server when `turn/interrupt` ended the turn cleanly.
      if (!terminal || !entry.live.alive) this.drop(entry);
      else this.idle(entry);
    }
  }

  /** Adds a user message to the turn running in a session. */
  async steer(sessionId: string, text: string, provider?: ProviderId): Promise<void> {
    const entry = this.find(sessionId, provider);
    if (!entry) throw new FunnelError(`No live session ${sessionId}. Turn on sessions.keepAlive and run a turn first.`, "invalid-selection");
    if (!entry.live.steer) throw new FunnelError(`${entry.provider} cannot add a message to a running turn.`, "unsupported");
    if (!entry.busy) throw new FunnelError(`No turn is running in session ${sessionId}.`, "invalid-selection");
    await entry.live.steer(text);
  }

  list(): LiveSessionInfo[] {
    return [...this.entries].flatMap((e) =>
      e.key && e.live.sessionId && e.live.alive
        ? [
            {
              provider: e.provider,
              sessionId: e.live.sessionId,
              model: e.selection.model,
              cwd: e.selection.cwd,
              access: e.selection.access,
              busy: e.busy,
              steer: Boolean(e.live.steer),
              lastUsed: e.lastUsed,
            },
          ]
        : [],
    );
  }

  /** Stops the process of one session. A running turn ends as cancelled. Returns false when there was none. */
  close(sessionId: string, provider?: ProviderId): boolean {
    const entry = this.find(sessionId, provider);
    if (!entry) return false;
    this.drop(entry);
    return true;
  }

  /** Stops every live process. Later turns start new ones. */
  closeAll(): void {
    for (const e of [...this.entries]) this.drop(e);
  }

  private find(sessionId: string, provider?: ProviderId): Entry | undefined {
    if (provider) return this.byKey.get(keyOf(provider, sessionId));
    return [...this.entries].find((e) => e.key && e.live.sessionId === sessionId);
  }

  private register(entry: Entry, sessionId: string): void {
    const key = keyOf(entry.provider, sessionId);
    if (entry.key === key) return;
    if (entry.key) this.byKey.delete(entry.key);
    const other = this.byKey.get(key);
    if (other && other !== entry) this.drop(other);
    entry.key = key;
    this.byKey.set(key, entry);
  }

  private idle(entry: Entry): void {
    entry.timer = setTimeout(() => this.drop(entry), this.idleMs);
    entry.timer.unref?.();
    // Over the limit: close the least recently used idle sessions.
    const idle = [...this.entries].filter((e) => !e.busy).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.entries.size > this.max && idle.length) this.drop(idle.shift()!);
  }

  private drop(entry: Entry): void {
    clearTimeout(entry.timer);
    this.entries.delete(entry);
    if (entry.key && this.byKey.get(entry.key) === entry) this.byKey.delete(entry.key);
    entry.live.close();
  }
}
