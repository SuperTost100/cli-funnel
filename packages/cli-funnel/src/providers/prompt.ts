import type { RunInput } from "../types.js";

/**
 * The prompt text for providers that take no system prompt or no schema flag.
 * Instructions go first, the schema request last, so the question stays in the middle.
 */
export function composePrompt(
  input: Pick<RunInput, "prompt" | "system" | "responseSchema">,
  opts: { system: boolean; schema: boolean },
): string {
  const parts: string[] = [];
  if (opts.system && input.system) parts.push(`<instructions>\n${input.system}\n</instructions>`);
  parts.push(input.prompt);
  if (opts.schema && input.responseSchema) {
    parts.push(
      "Reply with only a JSON value that matches this JSON Schema. No prose, no code fences.\n" +
        JSON.stringify(input.responseSchema.schema),
    );
  }
  return parts.join("\n\n");
}

/** Parses a JSON answer, tolerating a surrounding code fence. Throws when the text is not JSON. */
export function parseJsonAnswer(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}
