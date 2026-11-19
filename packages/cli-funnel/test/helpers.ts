import { createRunFolder } from "../src/providers/base.js";
import type { FunnelEvent, RunInput, RunResult } from "../src/types.js";

/** Folds an event stream into an API-shaped result. */
export async function collect(events: AsyncIterable<FunnelEvent>, input: RunInput): Promise<RunResult> {
  const folder = createRunFolder(input);
  for await (const e of events) folder.add(e);
  return folder.finish();
}

/** The same run on Antigravity's print transport. The offline tests of that transport fake `agy --print`. */
export function printTransport(input: RunInput): RunInput {
  return { ...input, providerOptions: { ...input.providerOptions, antigravity: { ...input.providerOptions?.antigravity, transport: "print" } } };
}
