import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createHandler } from "../src/server/handler.js";
import type { FunnelEvent, Provider } from "../src/types.js";

const fake: Provider = {
  id: "claude",
  displayName: "Fake",
  binary: "fake",
  capabilities: { access: ["supervised", "accept-edits", "full"], effort: true, contextWindow: false, fast: false, resume: true, approvals: true, images: false, system: "prompt", schema: "prompt" },
  detect: async () => ({ installed: true, testedRange: { min: "1.0.0" }, version: "1.0.0", withinTestedRange: true }),
  authStatus: async () => ({ loggedIn: true }),
  login: () => { throw new Error("no"); },
  logout: async () => {},
  update: async () => ({ changed: false, output: "" }),
  models: async () => [
    { id: "fake-1", name: "Fake 1", provider: "claude", efforts: [{ id: "high", label: "High" }], contextWindows: [], fast: false, source: "manifest" },
  ],
  async *run(input): AsyncGenerator<FunnelEvent> {
    yield { type: "session", sessionId: "s1" };
    if (input.selection.access === "supervised") {
      const request = { id: "a1", tool: "Bash", input: { cmd: "ls" } };
      yield { type: "approval.request", request };
      const d = await input.onApproval!(request);
      yield { type: "text.delta", text: d === "allow" ? "allowed" : "denied" };
    } else {
      yield { type: "text.delta", text: "hel" };
      yield { type: "text.delta", text: "lo" };
    }
    yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
    yield { type: "done", text: "", finishReason: "stop" };
  },
};

const empty = (id: Provider["id"]): Provider => ({ ...fake, id, models: async () => [] });
const funnel = createFunnel({
  providers: { claude: fake, codex: empty("codex"), agent: empty("agent"), antigravity: empty("antigravity"), "anthropic-api": empty("anthropic-api"), "openai-api": empty("openai-api") },
});
const handler = createHandler(funnel, { fsRoots: [tmpdir()], openai: { cwd: mkdtempSync(join(tmpdir(), "cf-")) } });
const call = (path: string, init?: RequestInit) => handler(new Request("http://x" + path, init));
const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

describe("server", () => {
  it("lists models as provider/model on /v1/models", async () => {
    const res = await (await call("/v1/models")).json();
    expect(res.data.map((m: { id: string }) => m.id)).toContain("claude/fake-1");
  });

  it("answers chat completions like the OpenAI API", async () => {
    const res = await (await post("/v1/chat/completions", { model: "claude/fake-1", messages: [{ role: "user", content: "hi" }] })).json();
    expect(res.choices[0].message.content).toBe("hello");
    expect(res.usage.total_tokens).toBe(5);
  });

  it("streams chat completions ending with [DONE]", async () => {
    const res = await post("/v1/chat/completions", { model: "claude/fake-1", stream: true, messages: [{ role: "user", content: "hi" }] });
    const body = await res.text();
    expect(body).toContain('"content":"hel"');
    expect(body.trim().endsWith("[DONE]")).toBe(true);
  });

  it("passes approvals through /run and /approvals", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cf-"));
    const res = await post("/run", { selection: { provider: "claude", model: "fake-1", cwd, access: "supervised" }, prompt: "go" });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = "";
    let runId = "";
    while (!seen.includes('"type":"done"')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
      runId ||= seen.match(/"runId":"([^"]+)"/)?.[1] ?? "";
      if (runId && seen.includes("approval.request") && !seen.includes("allowed")) {
        const r = await post(`/approvals/${runId}/a1`, { decision: "allow" });
        expect(r.status).toBe(200);
      }
    }
    expect(seen).toContain("allowed");
  });

  it("rejects an access level the provider cannot enforce", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cf-"));
    const res = await post("/run", { selection: { provider: "claude", model: "fake-1", cwd, access: "auto" }, prompt: "go" });
    expect(await res.text()).toContain("cannot enforce");
  });

  it("refuses a project folder outside the allowed roots", async () => {
    const res = await post("/run", { selection: { provider: "claude", model: "fake-1", cwd: "/etc", access: "full" }, prompt: "go" });
    expect(res.status).toBe(403);
  });

  it("requires the bearer token when one is set", async () => {
    const guarded = createHandler(funnel, { token: "s3cret" });
    expect((await guarded(new Request("http://x/providers"))).status).toBe(401);
    expect((await guarded(new Request("http://x/providers", { headers: { authorization: "Bearer s3cret" } }))).status).toBe(200);
  });
});
