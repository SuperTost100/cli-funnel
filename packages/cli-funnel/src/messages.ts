import { FunnelError, type ContentPart, type ImageAttachment, type Message, type RunInput, type RunRequest } from "./types.js";

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** The parts of a message. A string is one text part. */
export const partsOf = (m: Message): ContentPart[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);

/** The text parts of a message, joined. */
export const textOf = (m: Message): string =>
  partsOf(m)
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");

const imagesOf = (messages: Message[]): ImageAttachment[] => messages.flatMap((m) => partsOf(m).filter((p): p is ImageAttachment => p.type === "image"));

/** True when a message list carries tool calls or tool results. */
export const hasToolParts = (messages: Message[]): boolean =>
  messages.some((m) => typeof m.content !== "string" && m.content.some((p) => p.type === "tool_call" || p.type === "tool_result"));

/** Parses tool call arguments. Arguments that are not JSON stay a string; an empty string is an empty object. */
export function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The arguments of a tool call as a JSON string, for vendors that take them that way. */
export const stringifyArguments = (input: unknown): string => (typeof input === "string" ? input : JSON.stringify(input ?? {}));

/** The messages after the last assistant message: what a resumed session has not seen yet. */
export function pendingMessages(messages: Message[]): Message[] {
  return messages.slice(messages.findLastIndex((m) => m.role === "assistant") + 1);
}

/** The conversation of a run: `messages`, or one user message made of `prompt` and `attachments`. */
export function runMessages(input: RunInput): Message[] {
  if (input.messages) return input.messages;
  const images = input.attachments ?? [];
  return [{ role: "user", content: images.length ? [...images, { type: "text", text: input.prompt }] : input.prompt }];
}

const invalid = (message: string) => new FunnelError(message, "invalid-selection");

/** Throws `invalid-selection` when `messages` is not a conversation a provider can take. */
function checkMessages(messages: unknown): asserts messages is Message[] {
  if (!Array.isArray(messages) || messages.length === 0) throw invalid("messages must be a non-empty array.");
  for (const [i, m] of messages.entries()) {
    if (!m || typeof m !== "object") throw invalid(`messages[${i}] must be an object.`);
    const { role, content } = m as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") throw invalid(`messages[${i}].role must be "user" or "assistant". Put system instructions in system.`);
    if (typeof content === "string") continue;
    if (!Array.isArray(content)) throw invalid(`messages[${i}].content must be a string or an array of parts.`);
    for (const [j, p] of content.entries()) {
      const part = p as Record<string, unknown> | null;
      const at = `messages[${i}].content[${j}]`;
      if (part?.type === "text" && typeof part.text === "string") continue;
      if (part?.type === "image") {
        if (role !== "user") throw invalid(`${at}: only user messages can carry images.`);
        if (!MEDIA_TYPES.has(String(part.mediaType)) || typeof part.data !== "string") throw invalid(`${at} must have a png, jpeg, webp or gif mediaType and base64 data.`);
        continue;
      }
      if (part?.type === "tool_call") {
        if (role !== "assistant") throw invalid(`${at}: only assistant messages can carry tool calls.`);
        if (typeof part.id !== "string" || !part.id || typeof part.name !== "string" || !part.name) throw invalid(`${at} needs a string id and name.`);
        continue;
      }
      if (part?.type === "tool_result") {
        if (role !== "user") throw invalid(`${at}: only user messages can carry tool results.`);
        if (typeof part.toolCallId !== "string" || !part.toolCallId || typeof part.output !== "string") throw invalid(`${at} needs a string toolCallId and output.`);
        continue;
      }
      throw invalid(`${at} must be a text, image, tool_call or tool_result part.`);
    }
  }
  if (messages.at(-1).role !== "user") throw invalid("messages must end with a user message.");
}

/**
 * The text a provider without typed turns gets. A resumed session gets only the new messages, since the CLI holds the
 * rest. Otherwise one message is its own text, and several become a transcript with role prefixes.
 */
export function renderMessages(messages: Message[], resumed: boolean): string {
  if (resumed) return pendingMessages(messages).map(textOf).join("\n\n");
  if (messages.length === 1) return textOf(messages[0]!);
  return messages.map((m) => `${m.role.toUpperCase()}: ${textOf(m)}`).join("\n\n");
}

/**
 * Checks a run request and fills `prompt` and `attachments` from `messages`, so every provider gets a `RunInput`.
 * The attachments are the images of the messages a CLI is sent: the new ones on resume, else the last user message.
 */
export function toRunInput(req: RunRequest): RunInput {
  if (req.messages === undefined) {
    if (typeof req.prompt !== "string") throw invalid("Pass prompt or messages.");
    return req as RunInput;
  }
  if (req.prompt !== undefined) throw invalid("Pass prompt or messages, not both.");
  if (req.attachments?.length) throw invalid("With messages, put images in the message content instead of attachments.");
  checkMessages(req.messages);
  const resumed = !!req.sessionId;
  const images = imagesOf(resumed ? pendingMessages(req.messages) : [req.messages.at(-1)!]);
  return { ...req, prompt: renderMessages(req.messages, resumed), attachments: images.length ? images : undefined };
}
