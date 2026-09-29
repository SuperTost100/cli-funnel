import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planAccess } from "../src/providers/codex/access.js";
import { toApprovalRequest, toReply } from "../src/providers/codex/approvals.js";
import { parseLoginStatus } from "../src/providers/codex/auth.js";
import { Translator } from "../src/providers/codex/events.js";
import { codexProvider } from "../src/providers/codex/index.js";
import { parseCatalog } from "../src/providers/codex/models.js";
import { collect } from "../src/providers/base.js";
import type { FunnelEvent } from "../src/types.js";

const fx = (name: string) => new URL(`./fixtures/codex/${name}`, import.meta.url);
const load = (name: string) =>
  readFileSync(fx(name), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { dir: string; m: any });

function replay(name: string) {
  const rows = load(name);
  const thread = rows.find((r) => r.m.result?.thread)!.m.result.thread.id;
  const t = new Translator(thread);
  const events: FunnelEvent[] = [];
  const requests: any[] = [];
  for (const { dir, m } of rows) {
    if (dir !== "in" || !m.method) continue;
    if (m.id !== undefined) requests.push(m);
    else events.push(...t.handle(m.method, m.params).events);
  }
  return { events, requests, t };
}

describe("codex events", () => {
  it("translates a plain reply", () => {
    const { events } = replay("hello.ndjson");
    expect(events.filter((e) => e.type === "text.delta").length).toBeGreaterThan(0);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", finishReason: "stop" });
    expect(events.find((e) => e.type === "usage")).toBeTruthy();
  });

  it("emits tool events for a command", () => {
    const { events } = replay("approve-command.ndjson");
    const start = events.find((e) => e.type === "tool.start");
    expect(start).toMatchObject({ name: "command", input: { command: "/bin/zsh -lc 'echo hi > a.txt'" } });
    expect(events.find((e) => e.type === "tool.end")).toMatchObject({ error: undefined });
  });

  it("sums per-call usage over the turn", () => {
    const { events } = replay("approve-command.ndjson");
    const usage = events.filter((e) => e.type === "usage").at(-1) as Extract<FunnelEvent, { type: "usage" }>;
    expect(usage.usage.totalTokens).toBe(19245 + 19273);
  });

  it("ignores other threads", () => {
    const t = new Translator("a");
    expect(t.handle("item/agentMessage/delta", { threadId: "b", delta: "x" }).events).toEqual([]);
  });

  it("reports failed and interrupted turns", () => {
    const t = new Translator("a");
    expect(t.handle("turn/completed", { threadId: "a", turn: { status: "failed", error: { message: "boom" } } }).events[0]).toEqual({ type: "error", message: "boom" });
    expect(t.handle("turn/completed", { threadId: "a", turn: { status: "interrupted" } }).events[0]).toMatchObject({ finishReason: "cancelled" });
  });
});

describe("codex approvals", () => {
  it("maps a command approval and both decisions", () => {
    const { requests, t } = replay("approve-command.ndjson");
    const req = requests[0];
    const a = toApprovalRequest(req, t.items)!;
    expect(a.tool).toBe("command");
    expect(a.input).toMatchObject({ command: "/bin/zsh -lc 'echo hi > a.txt'" });
    expect(toReply(req, "allow")).toEqual({ result: { decision: "accept" } });
    expect(toReply(req, "deny")).toEqual({ result: { decision: "decline" } });
  });

  it("maps a file change approval using the item's changes", () => {
    const { requests, t } = replay("approve-file-change.ndjson");
    const a = toApprovalRequest(requests[0], t.items)!;
    expect(a.tool).toBe("file_change");
    expect((a.input as any).changes[0].path).toContain("b.txt");
  });

  it("rejects unknown server requests", () => {
    const req = { id: 1, method: "item/tool/call", params: {} };
    expect(toApprovalRequest(req, new Map())).toBeUndefined();
    expect(toReply(req, "allow")).toHaveProperty("error");
  });
});

describe("codex access plan", () => {
  it("maps each level", () => {
    expect(planAccess("supervised")).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write", autoAllowFileChanges: false });
    expect(planAccess("accept-edits")).toMatchObject({ approvalPolicy: "untrusted", autoAllowFileChanges: true });
    expect(planAccess("auto")).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
    expect(planAccess("full")).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });
});

describe("codex models and auth", () => {
  it("parses the catalog and skips hidden models", () => {
    const models = parseCatalog(readFileSync(fx("models.json"), "utf8"));
    expect(models.map((m) => m.id)).toContain("gpt-6-luna");
    expect(models.map((m) => m.id)).not.toContain("gpt-reserve");
    const luna = models.find((m) => m.id === "gpt-6-luna")!;
    expect(luna.fast).toBe(true);
    expect(luna.defaultEffort).toBe("medium");
    expect(luna.efforts.map((e) => e.id)).toContain("xhigh");
  });

  it("parses login status", () => {
    expect(parseLoginStatus("Logged in using ChatGPT\n")).toMatchObject({ loggedIn: true, method: "ChatGPT" });
    expect(parseLoginStatus("Logged in using an API key - sk-abc***")).toMatchObject({ loggedIn: true, method: "API key", detail: "Logged in using an API key" });
    expect(parseLoginStatus("Not logged in")).toMatchObject({ loggedIn: false });
  });
});

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1")("codex live", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cf-codex-live-"));
  const selection = { provider: "codex" as const, model: "gpt-6-luna", effort: "low", cwd, access: "supervised" as const };

  it("answers a tiny prompt", async () => {
    const input = { selection: { ...selection, access: "full" as const }, prompt: "say hi" };
    const res = await collect(codexProvider.run(input), input);
    expect(res.text.length).toBeGreaterThan(0);
    expect(res.sessionId).toBeTruthy();
  }, 90_000);

  it("asks before running a command and honors deny", async () => {
    const asked: string[] = [];
    const input = {
      selection,
      prompt: "Run the shell command: echo hi > a.txt . Then reply done.",
      onApproval: (r: { tool: string }) => {
        asked.push(r.tool);
        return "deny" as const;
      },
    };
    await collect(codexProvider.run(input), input);
    expect(asked).toContain("command");
    expect(() => readFileSync(join(cwd, "a.txt"))).toThrow();
  }, 120_000);
});
