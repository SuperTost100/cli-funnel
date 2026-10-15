import { readFile } from "node:fs/promises";
import type { Attachment, FunnelEvent, ResponseSchema, RunResult } from "../types.js";

/** A problem with what the user typed. The CLI prints it and exits with 2. */
export class UsageError extends Error {}

const USAGE = "Usage: cli-funnel run <provider> <model> [prompt | -]";

/** Reads the whole stream as UTF-8. */
export async function readAll(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of input) chunks.push(typeof c === "string" ? Buffer.from(c) : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The prompt is the words after the model, joined with spaces. With no words, or a single "-", it is read from stdin.
 * A terminal on stdin with nothing piped is an error instead of a hang.
 */
export async function resolvePrompt(words: string[], stdin: AsyncIterable<string | Uint8Array> & { isTTY?: boolean }): Promise<string> {
  const fromStdin = words.length === 0 || (words.length === 1 && words[0] === "-");
  if (!fromStdin) return words.join(" ");
  if (stdin.isTTY) throw new UsageError(`${USAGE}\nNo prompt. Pass it as an argument, or pipe it in.`);
  const text = (await readAll(stdin)).replace(/\r?\n$/, "");
  if (!text.trim()) throw new UsageError(`${USAGE}\nThe prompt from stdin is empty.`);
  return text;
}

/** Image type from the first bytes, so a wrong or missing file extension does not matter. */
export function sniffImageType(bytes: Uint8Array): Attachment["mediaType"] | undefined {
  const at = (i: number, s: string) => s.split("").every((c, j) => bytes[i + j] === c.charCodeAt(0));
  if (bytes[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF8")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return undefined;
}

/** Reads each --image file into an attachment. */
export async function loadImages(paths: string[] = []): Promise<Attachment[] | undefined> {
  if (!paths.length) return undefined;
  return Promise.all(
    paths.map(async (path): Promise<Attachment> => {
      const bytes = await readFile(path).catch((err: NodeJS.ErrnoException) => {
        throw new UsageError(`Cannot read --image ${path}: ${err.code ?? err.message}`);
      });
      const mediaType = sniffImageType(bytes);
      if (!mediaType) throw new UsageError(`--image ${path} is not a PNG, JPEG, WebP or GIF file.`);
      return { type: "image", mediaType, data: bytes.toString("base64") };
    }),
  );
}

/** Reads a JSON Schema file for --schema. */
export async function loadSchema(path?: string): Promise<ResponseSchema | undefined> {
  if (!path) return undefined;
  const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    throw new UsageError(`Cannot read --schema ${path}: ${err.code ?? err.message}`);
  });
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--schema ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new UsageError(`--schema ${path} must hold a JSON Schema object.`);
  return { schema: schema as Record<string, unknown> };
}

export interface RenderOptions {
  json?: boolean;
  quiet?: boolean;
  /** True when --schema was given. */
  schema?: boolean;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/**
 * Writes a run to the terminal and decides what stdout carries.
 *
 * - default: streamed text on stdout.
 * - --schema: only the structured answer on stdout.
 * - --json: only the result object on stdout. With --schema its `structured` field holds the answer.
 * - --quiet: nothing is streamed. Without --json or --schema the final text is written once at the end.
 *
 * Whenever stdout is reserved for data, streamed text is dropped and tool markers go to stderr, unless --quiet drops them too.
 * `structured` is false when --schema was given and no structured answer came back. The caller sets the exit code.
 */
export async function renderRun(
  stream: AsyncIterable<FunnelEvent> & { result: Promise<RunResult> },
  opts: RenderOptions,
): Promise<{ result: RunResult; structured: boolean }> {
  const data = opts.json || opts.schema;
  for await (const e of stream) {
    // A limit explains why the run failed or stalls, so it shows even with --quiet.
    if (e.type === "limit") {
      const when = e.resetAt ? ` Resets at ${e.resetAt}.` : e.retryAfterMs !== undefined ? ` Retry in ${Math.ceil(e.retryAfterMs / 1000)} s.` : "";
      opts.stderr(`\n[${e.kind} limit] ${e.detail}${when}\n`);
    }
    if (opts.quiet) continue;
    if (e.type === "text.delta" && !data) opts.stdout(e.text);
    else if (e.type === "tool.start") opts.stderr(`\n[tool] ${e.name}\n`);
  }
  const result = await stream.result;
  if (!opts.quiet && !data) opts.stdout("\n");
  if (result.sessionId) opts.stderr(`session ${result.sessionId}\n`);
  if (opts.json) opts.stdout(JSON.stringify(result, null, 2) + "\n");
  else if (opts.schema && result.structured !== undefined) opts.stdout(JSON.stringify(result.structured, null, 2) + "\n");
  else if (opts.quiet && !opts.schema) opts.stdout(result.text + "\n");
  const structured = !opts.schema || result.structured !== undefined;
  if (!structured) opts.stderr(`No structured answer${result.structuredError ? ": " + result.structuredError : ""}\n`);
  return { result, structured };
}
