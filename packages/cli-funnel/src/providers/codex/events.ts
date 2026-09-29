import type { FunnelEvent, Usage } from "../../types.js";

type Params = Record<string, any>;

export interface Translated {
  events: FunnelEvent[];
  /** Set when the turn is over. */
  finished?: boolean;
}

/** Maps app-server notifications for one thread to funnel events. */
export class Translator {
  /** File changes by item id, kept so approval requests can show them. */
  readonly items = new Map<string, unknown>();
  private messages: string[] = [];
  private usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 0 };

  constructor(private threadId: string) {}

  handle(method: string, p: Params = {}): Translated {
    if (p.threadId && p.threadId !== this.threadId) return { events: [] };
    switch (method) {
      case "item/agentMessage/delta":
        return { events: [{ type: "text.delta", text: p.delta }] };
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return { events: [{ type: "reasoning.delta", text: p.delta }] };
      case "item/started":
        return { events: this.itemStarted(p.item) };
      case "item/completed":
        return { events: this.itemCompleted(p.item) };
      case "thread/tokenUsage/updated": {
        const l = p.tokenUsage?.last;
        if (!l) return { events: [] };
        const u = this.usage;
        u.inputTokens += l.inputTokens;
        u.outputTokens += l.outputTokens;
        u.cachedInputTokens = (u.cachedInputTokens ?? 0) + l.cachedInputTokens;
        u.reasoningTokens = (u.reasoningTokens ?? 0) + l.reasoningOutputTokens;
        u.totalTokens += l.totalTokens;
        return { events: [{ type: "usage", usage: { ...u } }] };
      }
      case "error":
        if (p.willRetry) return { events: [] };
        return { events: [{ type: "error", message: p.error?.message ?? "Codex reported an error." }], finished: true };
      case "turn/completed":
        return this.turnCompleted(p.turn);
      default:
        return { events: [] };
    }
  }

  private itemStarted(item: Params): FunnelEvent[] {
    switch (item?.type) {
      case "commandExecution":
        return [{ type: "tool.start", id: item.id, name: "command", input: { command: item.command, cwd: item.cwd } }];
      case "fileChange":
        this.items.set(item.id, item.changes);
        return [{ type: "tool.start", id: item.id, name: "file_change", input: { changes: item.changes } }];
      case "mcpToolCall":
        return [{ type: "tool.start", id: item.id, name: `mcp:${item.server}/${item.tool}`, input: item.arguments }];
      case "dynamicToolCall":
        return [{ type: "tool.start", id: item.id, name: item.tool, input: item.arguments }];
      default:
        return [];
    }
  }

  private itemCompleted(item: Params): FunnelEvent[] {
    switch (item?.type) {
      case "agentMessage":
        if (item.text) this.messages.push(item.text);
        return [];
      case "commandExecution": {
        const bad = item.status === "failed" || item.status === "declined" || (item.exitCode ?? 0) !== 0;
        const code = item.exitCode != null ? ` (exit ${item.exitCode})` : "";
        return [{ type: "tool.end", id: item.id, output: item.aggregatedOutput ?? undefined, error: bad ? `Command ${item.status}${code}` : undefined }];
      }
      case "fileChange": {
        const bad = item.status === "failed" || item.status === "declined";
        return [{ type: "tool.end", id: item.id, error: bad ? `File change ${item.status}` : undefined }];
      }
      case "mcpToolCall": {
        const error = item.error?.message ?? (item.status === "failed" ? "MCP tool call failed" : undefined);
        const out = item.result ? JSON.stringify(item.result.structuredContent ?? item.result.content) : undefined;
        return [{ type: "tool.end", id: item.id, output: out, error }];
      }
      case "dynamicToolCall":
        return [{ type: "tool.end", id: item.id, error: item.success === false ? "Tool call failed" : undefined }];
      default:
        return [];
    }
  }

  private turnCompleted(turn: Params): Translated {
    if (turn?.status === "failed") {
      return { events: [{ type: "error", message: turn.error?.message ?? "Turn failed." }], finished: true };
    }
    const finishReason = turn?.status === "interrupted" ? "cancelled" : "stop";
    return { events: [{ type: "done", text: this.messages.join("\n\n"), finishReason }], finished: true };
  }
}
