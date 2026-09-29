import type { Funnel } from "../funnel.js";
import { ACCESS_LEVELS, type AccessLevel, type FinishReason, type ProviderId, type RunInput, type Usage } from "../types.js";
import { json, sse, sseHeaders } from "./sse.js";

export interface OpenAIDefaults {
  /** Project directory the agent works in. Default: the server's cwd. */
  cwd?: string;
  /** Access level for chat-completions calls. Default "accept-edits". "supervised" is denied here because the wire format has no approve button. */
  access?: AccessLevel;
}

interface ChatMessage {
  role: string;
  content: string | { type: string; text?: string }[] | null;
}

interface ChatBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  reasoning_effort?: string;
  /** cli-funnel extension. */
  x_funnel?: { cwd?: string; access?: AccessLevel; sessionId?: string; fast?: boolean; contextWindow?: number };
}

const text = (c: ChatMessage["content"]) =>
  typeof c === "string" ? c : (c ?? []).map((p) => (p.type === "text" ? p.text ?? "" : "")).join("");

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
    prompt: toPrompt(body.messages, !!body.x_funnel?.sessionId),
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
    return json({ error: { message: err instanceof Error ? err.message : String(err), type: "cli_funnel_error" } }, 500);
  }
}
