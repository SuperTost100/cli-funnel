import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
 * owner only, since they hold the whole conversation. Past `maxSessions` the least recently written files go.
 */
export function fileHistory(dir: string, maxSessions = MAX_SESSIONS): HistoryStore {
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
      const dated = await Promise.all(
        names.map(async (n) => ({ n, t: (await stat(join(dir, n)).catch(() => undefined))?.mtimeMs ?? 0 })),
      );
      dated.sort((a, b) => a.t - b.t);
      await Promise.all(dated.slice(0, names.length - maxSessions).map(({ n }) => unlink(join(dir, n)).catch(() => {})));
    },
  };
}

/** The store used when neither the run nor the funnel names one. */
const shared = memoryHistory();

/**
 * Runs one turn for a provider that keeps no server-side session. Prepends the stored history, emits `session`,
 * and stores the user message plus the streamed answer under the session id. A turn that fails, is cancelled or
 * produces no text is not stored: an empty assistant message makes some APIs reject every later turn.
 */
export async function* runWithHistory<M>(
  input: RunInput,
  user: M,
  assistant: (text: string) => M,
  stream: (messages: M[]) => AsyncIterable<FunnelEvent>,
): AsyncGenerator<FunnelEvent> {
  const store = input.history ?? shared;
  const sessionId = input.sessionId ?? randomUUID();
  const earlier = input.sessionId ? ((await store.get(sessionId)) as M[] | undefined) : undefined;
  const messages = [...(earlier ?? []), user];
  yield { type: "session", sessionId, model: input.selection.model };
  let text = "";
  let completed = false;
  for await (const e of stream(messages)) {
    if (e.type === "text.delta") text += e.text;
    if (e.type === "done") completed = e.finishReason !== "cancelled";
    if (e.type === "error") completed = false;
    yield e;
  }
  // A turn that did not finish leaves the store alone, so it cannot overwrite a turn that finished meanwhile.
  if (!completed || !text) return;
  await store.set(sessionId, [...messages, assistant(text)]);
}
