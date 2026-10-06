import { randomUUID } from "node:crypto";
import type { FunnelEvent, RunInput } from "../types.js";

// ponytail: conversation history lives in this process only. Persist it yourself if sessions must survive a restart.
const histories = new Map<string, unknown[]>();

/**
 * Runs one turn for a provider that keeps no server-side session. Prepends the stored history, emits `session`,
 * and stores the user message plus the streamed answer under the session id.
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
  for await (const e of stream(messages)) {
    if (e.type === "text.delta") text += e.text;
    yield e;
  }
  histories.set(sessionId, [...messages, assistant(text)]);
}
