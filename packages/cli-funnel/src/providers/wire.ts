import { randomUUID } from "node:crypto";
import { parseArguments, partsOf, stringifyArguments, textOf } from "../messages.js";
import { FunnelError, type ContentPart, type FunnelEvent, type Message, type ToolCall, type ToolChoice, type ToolDefinition } from "../types.js";
import { isObject } from "../util/is-object.js";
import { GEMINI_3_OR_LATER } from "./efforts.js";

/** One message in a vendor's own format. Stored in session history as it is. */
export interface Msg {
  role: "user" | "assistant" | "tool";
  /** A string, or vendor-shaped content parts. Chat Completions takes `null` next to tool calls. */
  content: string | unknown[] | null;
  /** Vendor fields such as `tool_calls` or `tool_call_id`. */
  [field: string]: unknown;
}

/** An id for a tool call when the vendor sends none (Gemini, Ollama). */
export const newCallId = (): string => `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

/** Parameters for a tool that declares none. */
const NO_PARAMETERS = { type: "object", properties: {} };

/** Arguments as an object, for vendors that take only objects. Arguments that were not JSON become `{}`. */
const argsObject = (input: unknown): Record<string, unknown> => (isObject(input) ? input : {});

/** The text a model sees for a tool result. Vendors without an error flag get the error marked in the text. */
const resultText = (output: string, isError?: boolean) => (isError ? `Error: ${output}` : output);

const unknownCall = (id: string) => new FunnelError(`A tool_result answers "${id}", but no tool call with that id is in the conversation.`, "invalid-selection");

// Anthropic Messages

export const anthropicTools = (tools: ToolDefinition[]) =>
  tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.parameters ?? NO_PARAMETERS }));

export const anthropicToolChoice = (c: ToolChoice) =>
  c === "auto" ? { type: "auto" } : c === "none" ? { type: "none" } : c === "required" ? { type: "any" } : { type: "tool", name: c.name };

function anthropicBlock(p: ContentPart): Record<string, unknown> {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "image":
      return { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } };
    case "tool_call":
      return { type: "tool_use", id: p.id, name: p.name, input: argsObject(p.input) };
    case "tool_result":
      return { type: "tool_result", tool_use_id: p.toolCallId, content: p.output, ...(p.isError ? { is_error: true } : {}) };
  }
}

/** Typed messages as Messages API turns. Tool results go first in their user message, as the API requires. */
export function anthropicMessages(messages: Message[]): Msg[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    const blocks = m.content.map(anthropicBlock);
    const results = blocks.filter((b) => b.type === "tool_result");
    return { role: m.role, content: results.length ? [...results, ...blocks.filter((b) => b.type !== "tool_result")] : blocks };
  });
}

// OpenAI Chat Completions, also spoken by OpenAI-compatible servers

export const chatTools = (tools: ToolDefinition[]) =>
  tools.map((t) => ({ type: "function", function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters ?? NO_PARAMETERS } }));

export const chatToolChoice = (c: ToolChoice) => (typeof c === "string" ? c : { type: "function", function: { name: c.name } });

const dataUrl = (p: { mediaType: string; data: string }) => `data:${p.mediaType};base64,${p.data}`;

const chatPart = (p: ContentPart) => (p.type === "image" ? { type: "image_url", image_url: { url: dataUrl(p) } } : { type: "text", text: p.type === "text" ? p.text : "" });

/**
 * Typed messages in Chat Completions format. Assistant turns are plain text plus `tool_calls`, which every server
 * takes. Each tool result becomes a `tool` message before the rest of its user message.
 */
export function chatMessages(messages: Message[]): Msg[] {
  return messages.flatMap((m): Msg[] => {
    const parts = partsOf(m);
    if (m.role === "assistant") return [chatAssistant(textOf(m), parts.filter((p) => p.type === "tool_call"))];
    if (typeof m.content === "string") return [{ role: "user", content: m.content }];
    const results: Msg[] = parts.flatMap((p) => (p.type === "tool_result" ? [{ role: "tool" as const, tool_call_id: p.toolCallId, content: resultText(p.output, p.isError) }] : []));
    const rest = parts.filter((p) => p.type === "text" || p.type === "image");
    return [...results, ...(rest.length ? [{ role: "user" as const, content: rest.map(chatPart) }] : [])];
  });
}

/** Collects Chat Completions tool call deltas, which arrive in pieces keyed by `index`. A pure fold, so it can be tested on fixtures. */
export function chatToolCalls(newId: () => string = newCallId) {
  const calls: { id: string; name: string; args: string }[] = [];
  return {
    /** Takes `delta.tool_calls` of one chunk and returns a `tool_call.delta` for each piece of arguments. */
    add(deltas: unknown): FunnelEvent[] {
      if (!Array.isArray(deltas)) return [];
      const out: FunnelEvent[] = [];
      for (const d of deltas as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
        const i = typeof d.index === "number" ? d.index : calls.length;
        const call = (calls[i] ??= { id: d.id || newId(), name: "", args: "" });
        if (d.function?.name) call.name = d.function.name;
        const piece = d.function?.arguments;
        if (typeof piece === "string" && piece) {
          call.args += piece;
          out.push({ type: "tool_call.delta", id: call.id, name: call.name, arguments: piece });
        }
      }
      return out;
    },
    /** The finished calls, in order, with parsed arguments. */
    finish: (): ToolCall[] => calls.filter(Boolean).map((c) => ({ id: c.id, name: c.name, input: parseArguments(c.args) })),
  };
}

/** The assistant message Chat Completions takes back: the text and the tool calls of the turn. */
export const chatAssistant = (text: string, calls: ToolCall[]): Msg =>
  calls.length
    ? {
        role: "assistant",
        content: text || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: stringifyArguments(c.input) } })),
      }
    : { role: "assistant", content: text };

// OpenAI Responses

export const responsesTools = (tools: ToolDefinition[]) =>
  tools.map((t) => ({ type: "function", name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.parameters ?? NO_PARAMETERS }));

export const responsesToolChoice = (c: ToolChoice) => (typeof c === "string" ? c : { type: "function", name: c.name });

const responsesPart = (p: ContentPart) => (p.type === "image" ? { type: "input_image", image_url: dataUrl(p) } : { type: "input_text", text: p.type === "text" ? p.text : "" });

/** Typed messages as Responses input items. Tool calls and their results are items of their own, not message content. */
export function responsesInput(messages: Message[]): Record<string, unknown>[] {
  return messages.flatMap((m) => {
    if (typeof m.content === "string") return [{ role: m.role, content: m.content }];
    const items: Record<string, unknown>[] = [];
    const rest: ContentPart[] = [];
    for (const p of m.content) {
      if (p.type === "tool_call") items.push({ type: "function_call", call_id: p.id, name: p.name, arguments: stringifyArguments(p.input) });
      else if (p.type === "tool_result") items.push({ type: "function_call_output", call_id: p.toolCallId, output: resultText(p.output, p.isError) });
      else rest.push(p);
    }
    if (!rest.length) return items;
    const message =
      m.role === "assistant"
        ? { role: "assistant", content: rest.map((p) => (p.type === "text" ? p.text : "")).join("") }
        : { role: "user", content: rest.map(responsesPart) };
    // A tool result answers the call before it, so results go first; an assistant's text comes before its calls.
    return m.role === "assistant" ? [message, ...items] : [...items, message];
  });
}

// Gemini generateContent

export const geminiTools = (tools: ToolDefinition[]) => [
  { functionDeclarations: tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), parametersJsonSchema: t.parameters ?? NO_PARAMETERS })) },
];

export const geminiToolConfig = (c: ToolChoice) => ({
  functionCallingConfig:
    c === "auto" ? { mode: "AUTO" } : c === "none" ? { mode: "NONE" } : c === "required" ? { mode: "ANY" } : { mode: "ANY", allowedFunctionNames: [c.name] },
});

/**
 * Gemini 3 rejects a function call in the current turn that has no thought signature. A call that comes from the
 * caller and not from stored history has none, so it gets the value Google documents for history from elsewhere.
 */
const SKIP_SIGNATURE = "skip_thought_signature_validator";
const signsCalls = (model: string) => GEMINI_3_OR_LATER.test(model);

/** Tool call names by id, from typed messages and from stored history in either vendor format. */
function callNames(messages: Message[], earlier: Msg[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of earlier) {
    for (const c of (Array.isArray(m.tool_calls) ? m.tool_calls : []) as { id?: string; function?: { name?: string } }[]) {
      if (c.id && c.function?.name) names.set(c.id, c.function.name);
    }
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as { functionCall?: { id?: string; name?: string } }[]) if (p?.functionCall?.id && p.functionCall.name) names.set(p.functionCall.id, p.functionCall.name);
  }
  for (const m of messages) for (const p of partsOf(m)) if (p.type === "tool_call") names.set(p.id, p.name);
  return names;
}

/** Typed messages as Gemini turns. Roles are mapped to `model` when the request is built. */
export function geminiMessages(messages: Message[], model: string, earlier: Msg[] = []): Msg[] {
  const names = callNames(messages, earlier);
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    let signed = !signsCalls(model);
    const parts = m.content.map((p) => {
      switch (p.type) {
        case "text":
          return { text: p.text };
        case "image":
          return { inlineData: { mimeType: p.mediaType, data: p.data } };
        case "tool_call": {
          const part = { functionCall: { id: p.id, name: p.name, args: argsObject(p.input) }, ...(signed ? {} : { thoughtSignature: SKIP_SIGNATURE }) };
          signed = true;
          return part;
        }
        case "tool_result": {
          const name = names.get(p.toolCallId);
          if (!name) throw unknownCall(p.toolCallId);
          return { functionResponse: { id: p.toolCallId, name, response: p.isError ? { error: p.output } : { output: p.output } } };
        }
      }
    });
    return { role: m.role, content: parts };
  });
}

// Ollama /api/chat

/** Typed messages in Ollama's format: text in `content`, images as base64 in `images`, tool results as `tool` messages. */
export function ollamaMessages(messages: Message[], earlier: Msg[] = []): Msg[] {
  const names = callNames(messages, earlier);
  return messages.flatMap((m): Msg[] => {
    const parts = partsOf(m);
    const calls = parts.filter((p) => p.type === "tool_call");
    if (m.role === "assistant") {
      return [{ role: "assistant", content: textOf(m), ...(calls.length ? { tool_calls: ollamaCalls(calls) } : {}) }];
    }
    const results: Msg[] = parts.flatMap((p) => {
      if (p.type !== "tool_result") return [];
      const name = names.get(p.toolCallId);
      if (!name) throw unknownCall(p.toolCallId);
      return [{ role: "tool" as const, content: resultText(p.output, p.isError), tool_name: name }];
    });
    const images = parts.flatMap((p) => (p.type === "image" ? [p.data] : []));
    const text = textOf(m);
    const rest = parts.some((p) => p.type === "text" || p.type === "image") || typeof m.content === "string";
    return [...results, ...(rest ? [{ role: "user" as const, content: text, ...(images.length ? { images } : {}) }] : [])];
  });
}

/** Tool calls as Ollama takes them back. The id is kept so a later tool result can find the call's name. */
export const ollamaCalls = (calls: ToolCall[]) => calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: argsObject(c.input) } }));
