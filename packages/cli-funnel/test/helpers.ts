import { createRunFolder } from "../src/providers/base.js";
import type { FunnelEvent, RunInput, RunResult } from "../src/types.js";

/** Folds an event stream into an API-shaped result. */
export async function collect(events: AsyncIterable<FunnelEvent>, input: RunInput): Promise<RunResult> {
  const folder = createRunFolder(input);
  for await (const e of events) folder.add(e);
  return folder.finish();
}
