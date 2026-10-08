import { randomUUID } from "node:crypto";
import type { FunnelEvent, RunInput } from "../types.js";

// ponytail: conversation history lives in this process only. Persist it yourself if sessions must survive a restart.
const histories = new Map<string, unknown[]>();
/** Sessions kept before the least recently used one is dropped. Keeps a long-running server from growing without bound. */
export const MAX_SESSIONS = 500;

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
  const sessionId = input.sessionId ?? randomUUID();
  const messages = [...((histories.get(sessionId) ?? []) as M[]), user];
  yield { type: "session", sessionId, model: input.selection.model };
  let text = "";
  let completed = false;
  for await (const e of stream(messages)) {
    if (e.type === "text.delta") text += e.text;
    if (e.type === "done") completed = e.finishReason !== "cancelled";
    if (e.type === "error") completed = false;
    yield e;
  }
  // A turn that did not finish leaves the map alone, so it cannot overwrite a turn that finished meanwhile.
  if (!completed || !text) return;
  // Deleting first moves the session to the end of the map, which keeps it in least-recently-used order.
  histories.delete(sessionId);
  histories.set(sessionId, [...messages, assistant(text)]);
  while (histories.size > MAX_SESSIONS) histories.delete(histories.keys().next().value!);
}
