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
  return JSON.parse(unfence(trimmed) ?? trimmed);
}

/**
 * The text inside a code fence that spans the whole input: an opening ``` with an optional `json` tag and a line
 * break, and a closing ``` at the end. Plain string operations, so a long unterminated fence costs linear time.
 */
function unfence(text: string): string | undefined {
  if (text.length < 6 || !text.startsWith("```") || !text.endsWith("```")) return undefined;
  let body = text.slice(3, -3);
  if (body.slice(0, 4).toLowerCase() === "json") body = body.slice(4);
  // The opening line ends at the last line break of the whitespace that follows the tag.
  let lineEnd = -1;
  for (let i = 0; i < body.length && /\s/.test(body[i]!); i++) if (body[i] === "\n") lineEnd = i;
  if (lineEnd < 0) return undefined;
  body = body.slice(lineEnd + 1);
  return body.endsWith("\n") ? body.slice(0, -1) : body;
}
