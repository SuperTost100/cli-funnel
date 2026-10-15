import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FunnelEvent, HistoryStore, RunInput } from "../types.js";

/** Sessions kept before the least recently used one is dropped. Keeps a long-running server from growing without bound. */
export const MAX_SESSIONS = 500;

/** Keeps history in this process. It is gone when the process ends. */
export function memoryHistory(maxSessions = MAX_SESSIONS): HistoryStore {
  const histories = new Map<string, unknown[]>();
  return {
    get: (id) => histories.get(id),
    set(id, messages) {
      // Deleting first moves the session to the end of the map, which keeps it in least-recently-used order.
      histories.delete(id);
      histories.set(id, messages);
      while (histories.size > maxSessions) histories.delete(histories.keys().next().value!);
    },
  };
}

/**
 * Keeps history as one JSON file per session in `dir`, so sessions survive a restart. Files are readable by the
 * owner only, since they hold the whole conversation. Past `maxSessions` the least recently written files go. Files
 * written less than `graceMs` ago are never removed, so a session that was just saved cannot be evicted by a write
 * from another process.
 */
export function fileHistory(dir: string, maxSessions = MAX_SESSIONS, graceMs = 5000): HistoryStore {
  // Hashing the id keeps a caller-chosen session id from naming a path outside `dir`.
  const file = (id: string) => join(dir, `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`);
  return {
    async get(id) {
      const raw = await readFile(file(id), "utf8").catch(() => undefined);
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw) as { sessionId?: string; messages?: unknown[] };
        return parsed.sessionId === id && Array.isArray(parsed.messages) ? parsed.messages : undefined;
      } catch {
        return undefined;
      }
    },
    async set(id, messages) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = file(id);
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      // Write and rename, so a crash mid-write cannot leave a half file behind.
      await writeFile(tmp, JSON.stringify({ sessionId: id, messages }), { mode: 0o600 });
      await rename(tmp, target);
      const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
      if (names.length <= maxSessions) return;
      const now = Date.now();
      const dated = await Promise.all(
        names.map(async (n) => ({ n, t: (await stat(join(dir, n)).catch(() => undefined))?.mtimeMs ?? 0 })),
      );
      // Ties on the modification time fall back to the name, so the order does not depend on the directory listing.
      dated.sort((a, b) => a.t - b.t || a.n.localeCompare(b.n));
      const evictable = dated.filter(({ n, t }) => n !== basename(target) && now - t >= graceMs);
      await Promise.all(evictable.slice(0, names.length - maxSessions).map(({ n }) => unlink(join(dir, n)).catch(() => {})));
    },
  };
}

/** The store for a provider that is run without a funnel and without a store of its own. `createFunnel` makes its own. */
const shared = memoryHistory();

/** Turns on the same session wait for each other, so a turn never starts from a history that another turn is about to change. */
const queues = new WeakMap<HistoryStore, Map<string, Promise<void>>>();

/** Resolves when every earlier turn on `key` has ended. Call `release` when this turn ends, even if it never started waiting. */
function enqueue(store: HistoryStore, key: string): { ready: Promise<void>; release: () => void } {
  let map = queues.get(store);
  if (!map) queues.set(store, (map = new Map()));
  const before = map.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = before.then(() => mine);
  map.set(key, tail);
  return {
    ready: before,
    release() {
      release();
      void tail.then(() => map.get(key) === tail && map.delete(key));
    },
  };
}

/**
 * Runs one turn for a provider that keeps no server-side session. Prepends the stored history, emits `session`,
 * and stores the user message plus the streamed answer under the session id. A turn that fails, is cancelled or
 * produces no text is not stored: an empty assistant message makes some APIs reject every later turn.
 *
 * Entries are keyed by provider and session id, so a session cannot be resumed on a provider whose message format
 * differs. Turns on one session run one after another. The turn is stored before `done` is yielded, so a consumer
 * that stops at `done` still leaves it in the store.
 */
export async function* runWithHistory<M>(
  input: RunInput,
  user: M,
  assistant: (text: string) => M,
  stream: (messages: M[]) => AsyncIterable<FunnelEvent>,
): AsyncGenerator<FunnelEvent> {
  const store = input.history ?? shared;
  const sessionId = input.sessionId ?? randomUUID();
  const key = `${input.selection.provider}:${sessionId}`;
  // A new session id cannot collide with another turn, so only a resumed session waits.
  const turn = input.sessionId ? enqueue(store, key) : undefined;
  try {
    if (turn) {
      const cancelled = new Promise<"cancelled">((resolve) => {
        if (input.signal?.aborted) resolve("cancelled");
        input.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
      });
      if ((await Promise.race([turn.ready, cancelled])) === "cancelled") return yield { type: "done", text: "", finishReason: "cancelled" };
    }
    const earlier = input.sessionId ? ((await store.get(key)) as M[] | undefined) : undefined;
    const messages = [...(earlier ?? []), user];
    yield { type: "session", sessionId, model: input.selection.model };
    let text = "";
    let failed = false;
    for await (const e of stream(messages)) {
      if (e.type === "text.delta") text += e.text;
      if (e.type === "error") failed = true;
      // A turn that did not finish leaves the store alone, so it cannot overwrite a turn that finished meanwhile.
      if (e.type === "done" && e.finishReason !== "cancelled" && !failed && text) await store.set(key, [...messages, assistant(text)]);
      yield e;
    }
  } finally {
    turn?.release();
  }
}
