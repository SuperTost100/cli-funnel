import type { ApprovalDecision, ApprovalReply, ApprovalRequest, Question, QuestionAnswers, QuestionRequest } from "../../types.js";
import { approvalReply } from "../base.js";
import type { McpCall } from "./events.js";

export interface ServerRequest {
  id: string | number;
  method: string;
  params: Record<string, any>;
}

export type Reply = { result: unknown } | { error: { code: number; message: string } };

/** What the translator saw of the turn, so an approval request can show the change or the tool it is about. */
export interface ApprovalContext {
  items: Map<string, unknown>;
  mcpCalls: Map<string, McpCall>;
}

/**
 * Codex asks to approve an MCP tool call through an elicitation with this `_meta.codex_approval_kind`. With the
 * `tool_call_mcp_elicitation` feature off it asks through `item/tool/requestUserInput` instead, with a question id that
 * starts with the prefix below, and reads the answer label.
 */
const MCP_APPROVAL_KIND = "mcp_tool_call";
const MCP_APPROVAL_QUESTION = "mcp_tool_call_approval";
const MCP_APPROVAL_ALLOW = "Allow";
const MCP_APPROVAL_CANCEL = "Cancel";

const USER_INPUT = "item/tool/requestUserInput";

/** True for a `requestUserInput` request that is really an MCP tool approval. */
function isMcpApprovalQuestion(req: ServerRequest): boolean {
  const qs = req.params.questions;
  return req.method === USER_INPUT && Array.isArray(qs) && qs.some((q) => typeof q?.id === "string" && q.id.startsWith(MCP_APPROVAL_QUESTION));
}

/** True for a server request that asks the user questions, as opposed to an approval. */
export function isQuestion(req: ServerRequest): boolean {
  return req.method === USER_INPUT && !isMcpApprovalQuestion(req);
}

/** The public tool name and input of an MCP tool call, from the call the translator saw start. */
function mcpTool(call: McpCall | undefined, server: string | undefined): { tool: string; input?: unknown } {
  if (!call) return { tool: "mcp" };
  return { tool: server ? `mcp:${server}/${call.tool}` : `mcp:${call.tool}`, input: call.arguments };
}

/** Turns a server approval request into the public shape. Returns undefined for methods that are not approvals. */
export function toApprovalRequest(req: ServerRequest, ctx: ApprovalContext): ApprovalRequest | undefined {
  const p = req.params;
  switch (req.method) {
    case "item/commandExecution/requestApproval":
      return {
        id: String(p.approvalId ?? p.itemId),
        tool: "command",
        input: { command: p.command, cwd: p.cwd, reason: p.reason },
        description: p.reason ?? p.command ?? undefined,
      };
    case "item/fileChange/requestApproval":
      return {
        id: String(p.itemId),
        tool: "file_change",
        input: { changes: ctx.items.get(p.itemId), reason: p.reason, grantRoot: p.grantRoot },
        description: p.reason ?? undefined,
      };
    case "mcpServer/elicitation/request": {
      if (p._meta?.codex_approval_kind === MCP_APPROVAL_KIND) {
        const { tool, input } = mcpTool(ctx.mcpCalls.get(p.serverName), p.serverName);
        return { id: String(req.id), tool, input: input ?? p._meta?.tool_params ?? p, description: p.message ?? undefined };
      }
      return { id: String(req.id), tool: "mcp", input: p, description: p.message ?? undefined };
    }
    case USER_INPUT: {
      if (!isMcpApprovalQuestion(req)) return undefined;
      const [server, call] = [...ctx.mcpCalls].find(([, c]) => c.id === p.itemId) ?? [];
      const { tool, input } = mcpTool(call, server);
      const q = p.questions.find((x: any) => String(x?.id).startsWith(MCP_APPROVAL_QUESTION));
      return { id: String(p.itemId ?? req.id), tool, input: input ?? { question: q?.question }, description: q?.question ?? undefined };
    }
    default:
      return undefined;
  }
}

/**
 * The reply Codex can act on. Codex cannot change a tool's input, so an allow with `updatedInput` becomes a deny,
 * as the contract asks. The message stays.
 */
export function effectiveReply(decision: ApprovalDecision): ApprovalReply {
  const reply = approvalReply(decision);
  if (reply.decision === "allow" && reply.updatedInput !== undefined) return reply.message ? { decision: "deny", message: reply.message } : { decision: "deny" };
  return reply;
}

/**
 * The text sent with `turn/steer` before a decline that carries a message. Codex's decline has no reason field, so the
 * message reaches the agent as a user message in the same turn. Undefined when there is nothing to send.
 */
export function denyNote(reply: ApprovalReply): string | undefined {
  if (reply.decision !== "deny" || !reply.message) return undefined;
  return `The user denied that action and said: ${reply.message}`;
}

export function toReply(req: ServerRequest, decision: ApprovalDecision): Reply {
  const allow = effectiveReply(decision).decision === "allow";
  switch (req.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: allow ? "accept" : "decline" } };
    case "mcpServer/elicitation/request":
      return { result: { action: allow ? "accept" : "decline", content: null, _meta: null } };
    case USER_INPUT: {
      if (!isMcpApprovalQuestion(req)) return { result: { answers: {} } };
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of req.params.questions) {
        if (String(q?.id).startsWith(MCP_APPROVAL_QUESTION)) answers[q.id] = { answers: [allow ? MCP_APPROVAL_ALLOW : MCP_APPROVAL_CANCEL] };
      }
      return { result: { answers } };
    }
    default:
      return { error: { code: -32601, message: `Unsupported request ${req.method}` } };
  }
}

/** A `item/tool/requestUserInput` request as the public question shape. Codex marks every question `isOther`. */
export function toQuestionRequest(req: ServerRequest): QuestionRequest {
  const p = req.params;
  const questions: Question[] = (Array.isArray(p.questions) ? p.questions : []).map((q: any) => {
    const out: Question = {
      id: String(q.id),
      question: String(q.question ?? ""),
      options: (Array.isArray(q.options) ? q.options : []).map((o: any) => (o.description ? { label: String(o.label), description: String(o.description) } : { label: String(o.label) })),
    };
    if (q.header) out.header = String(q.header);
    if (q.isOther) out.allowOther = true;
    if (q.isSecret) out.secret = true;
    return out;
  });
  return { id: String(p.itemId ?? req.id), questions };
}

/**
 * The reply to `item/tool/requestUserInput`. A chosen option goes as its label. Other text goes as `user_note: <text>`,
 * the form Codex's own TUI sends for a typed answer. Null, the user not answering, sends no answers: the model gets
 * `{"answers":{}}` as the tool result. Codex has no separate decline reply.
 */
export function toQuestionReply(req: ServerRequest, answers: QuestionAnswers | null): Reply {
  const out: Record<string, { answers: string[] }> = {};
  for (const q of Array.isArray(req.params.questions) ? req.params.questions : []) {
    const given = answers?.[q.id];
    if (!given) continue;
    const labels = new Set((Array.isArray(q.options) ? q.options : []).map((o: any) => o.label));
    out[q.id] = { answers: given.map((a) => (labels.has(a) ? a : `user_note: ${a}`)) };
  }
  return { result: { answers: out } };
}
