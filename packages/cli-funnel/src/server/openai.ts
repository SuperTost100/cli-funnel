import type { Funnel } from "../funnel.js";
import { ACCESS_LEVELS, FunnelError, type AccessLevel, type Attachment, type FinishReason, type ProviderId, type RunInput, type Usage } from "../types.js";
import { json, sse, sseHeaders } from "./sse.js";

export interface OpenAIDefaults {
  /** Project directory the agent works in. Default: the server's cwd. */
  cwd?: string;
  /** Access level for chat-completions calls. Default "accept-edits". "supervised" is denied here because the wire format has no approve button. */
  access?: AccessLevel;
}

interface ChatMessage {
  role: string;
  content: string | { type: string; text?: string; image_url?: { url: string } }[] | null;
}

interface ChatBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  reasoning_effort?: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: { type: string; json_schema?: { name?: string; schema?: Record<string, unknown> } };
  /** cli-funnel extension. */
  x_funnel?: { cwd?: string; access?: AccessLevel; sessionId?: string; fast?: boolean; contextWindow?: number };
}

const text = (c: ChatMessage["content"]) =>
  typeof c === "string" ? c : (c ?? []).map((p) => (p.type === "text" ? p.text ?? "" : "")).join("");

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/;

/** Images from the last user turn. Only data URLs: fetching remote URLs would make this server a proxy. */
function toAttachments(messages: ChatMessage[]): Attachment[] {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last || typeof last.content === "string" || !last.content) return [];
  return last.content.flatMap((p): Attachment[] => {
    const m = p.type === "image_url" && p.image_url ? IMAGE_DATA_URL.exec(p.image_url.url) : null;
    return m ? [{ type: "image", mediaType: m[1] as Attachment["mediaType"], data: m[2]! }] : [];
  });
}

/** Flattens a chat into one prompt. The CLI keeps its own history when sessionId is set, so only the last user turn is sent then. */
function toPrompt(messages: ChatMessage[], resumed: boolean): string {
  if (resumed) return text([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
  if (messages.length === 1) return text(messages[0]!.content);
  return messages.map((m) => `${m.role.toUpperCase()}: ${text(m.content)}`).join("\n\n");
}

const finish = (r: FinishReason) => (r === "stop" ? "stop" : r === "cancelled" ? "stop" : r === "denied" ? "content_filter" : "stop");

const usageOut = (u?: Usage) =>
  u ? { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.totalTokens } : undefined;

/** Model ids on this endpoint are "<provider>/<model>", for example "claude/claude-sonnet-5". */
export async function handleOpenAI(
  funnel: Funnel,
  req: Request,
  path: string,
  defaults: OpenAIDefaults = {},
  cwdAllowed: (cwd: string) => boolean = () => true,
): Promise<Response> {
  if (req.method === "GET" && path === "/v1/models") {
    const ids = Object.keys(funnel.providers) as ProviderId[];
    const lists = await Promise.all(ids.map((id) => funnel.models(id).catch(() => [])));
    const data = ids.flatMap((id, i) => lists[i]!.map((m) => ({ id: `${id}/${m.id}`, object: "model", owned_by: id, name: m.name })));
    return json({ object: "list", data });
  }

  if (req.method !== "POST" || path !== "/v1/chat/completions") return json({ error: { message: "Not found" } }, 404);

  const body = (await req.json()) as ChatBody;
  const slash = body.model.indexOf("/");
  const provider = body.model.slice(0, slash) as ProviderId;
  const model = body.model.slice(slash + 1);
  if (slash < 0 || !funnel.providers[provider]) {
    return json({ error: { message: 'model must look like "<provider>/<model>", for example "claude/claude-sonnet-5".' } }, 400);
  }
  const access = body.x_funnel?.access ?? defaults.access ?? "accept-edits";
  if (!ACCESS_LEVELS.includes(access)) return json({ error: { message: `bad access "${access}"` } }, 400);

  const cwd = body.x_funnel?.cwd ?? defaults.cwd ?? process.cwd();
  if (body.x_funnel?.cwd && !cwdAllowed(cwd)) return json({ error: { message: "x_funnel.cwd is outside the allowed roots." } }, 403);

  const input: RunInput = {
    selection: {
      provider,
      model,
      effort: body.reasoning_effort,
      fast: body.x_funnel?.fast,
      contextWindow: body.x_funnel?.contextWindow,
      cwd,
      access,
    },
    // System messages become the run's system prompt instead of a line in the flattened chat.
    prompt: toPrompt(body.messages.filter((m) => m.role !== "system"), !!body.x_funnel?.sessionId),
    system: body.messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n\n") || undefined,
    attachments: toAttachments(body.messages),
    responseSchema:
      body.response_format?.type === "json_schema" && body.response_format.json_schema?.schema
        ? { name: body.response_format.json_schema.name, schema: body.response_format.json_schema.schema }
        : undefined,
    maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
    sessionId: body.x_funnel?.sessionId,
    signal: req.signal,
    onApproval: () => "deny",
  };

  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: object, finish_reason: string | null = null, extra: object = {}) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: body.model,
    choices: [{ index: 0, delta, finish_reason }],
    ...extra,
  });

  try {
    if (!body.stream) {
      const r = await funnel.run(input);
      return json({
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: finish(r.finishReason) }],
        usage: usageOut(r.usage),
        x_funnel: { sessionId: r.sessionId, toolCalls: r.toolCalls, deniedActions: r.deniedActions },
      });
    }
    const stream = funnel.stream(input);
    const chunks = (async function* () {
      yield chunk({ role: "assistant" });
      let usage: Usage | undefined;
      let reason: FinishReason = "stop";
      let sessionId: string | undefined;
      for await (const e of stream) {
        if (e.type === "text.delta") yield chunk({ content: e.text });
        else if (e.type === "session") sessionId = e.sessionId;
        else if (e.type === "usage") usage = e.usage;
        else if (e.type === "done") reason = e.finishReason;
        else if (e.type === "error") throw new Error(e.message);
      }
      yield chunk({}, finish(reason), { usage: usageOut(usage), x_funnel: { sessionId } });
    })();
    return new Response(sse(chunks, { done: "[DONE]" }), { headers: sseHeaders });
  } catch (err) {
    const status = err instanceof FunnelError ? (err.code === "invalid-selection" ? 400 : 409) : 500;
    return json({ error: { message: err instanceof Error ? err.message : String(err), type: "cli_funnel_error", code: (err as FunnelError).code } }, status);
  }
}
