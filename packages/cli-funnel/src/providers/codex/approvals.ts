import type { ApprovalDecision, ApprovalRequest } from "../../types.js";

export interface ServerRequest {
  id: string | number;
  method: string;
  params: Record<string, any>;
}

export type Reply = { result: unknown } | { error: { code: number; message: string } };

/** Turns a server approval request into the public shape. Returns undefined for methods that are not approvals. */
export function toApprovalRequest(req: ServerRequest, items: Map<string, unknown>): ApprovalRequest | undefined {
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
        input: { changes: items.get(p.itemId), reason: p.reason, grantRoot: p.grantRoot },
        description: p.reason ?? undefined,
      };
    case "mcpServer/elicitation/request":
      return { id: String(req.id), tool: "mcp", input: p, description: p.message ?? undefined };
    default:
      return undefined;
  }
}

export function toReply(req: ServerRequest, decision: ApprovalDecision): Reply {
  const allow = decision === "allow";
  switch (req.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: allow ? "accept" : "decline" } };
    case "mcpServer/elicitation/request":
      return { result: { action: allow ? "accept" : "decline", content: null, _meta: null } };
    default:
      return { error: { code: -32601, message: `Unsupported request ${req.method}` } };
  }
}
