import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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

  it("steps the default access down to one the provider can enforce", async () => {
    const echo: Provider = {
      ...fake,
      id: "agent",
      capabilities: { ...fake.capabilities, access: ["none", "auto", "full"] },
      models: async () => [{ ...(await fake.models())[0]!, provider: "agent" }],
      async *run(input) {
        yield { type: "text.delta", text: input.selection.access };
        yield { type: "done", text: "", finishReason: "stop" };
      },
    };
    const h = createHandler(createFunnel({ providers: { agent: echo } }), { openai: { cwd: tmpdir(), access: "accept-edits" } });
    const ask = async (extra: object = {}) =>
      (await h(new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "agent/fake-1", messages: [{ role: "user", content: "hi" }], ...extra }) })))
        .json();
    expect((await ask()).choices[0].message.content).toBe("none");
    expect((await ask({ x_funnel: { access: "full" } })).choices[0].message.content).toBe("full");
    expect((await ask({ x_funnel: { access: "accept-edits" } })).error).toBeDefined();
  });

  it("answers 400 for a model the provider does not list", async () => {
    const res = await post("/v1/chat/completions", { model: "claude/nope", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
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

  it("follows symlinks before checking the allowed roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-root-"));
    const outside = mkdtempSync(join(tmpdir(), "cf-out-"));
    mkdirSync(join(outside, "secret"));
    symlinkSync(outside, join(root, "escape"));
    mkdirSync(join(root, "inner"));
    symlinkSync(join(root, "inner"), join(root, "alias"));
    const h = createHandler(funnel, { fsRoots: [root] });
    const fs = (p: string) => h(new Request(`http://x/fs?path=${encodeURIComponent(p)}`));
    expect((await fs(join(root, "escape"))).status).toBe(403);
    expect((await fs(join(root, "alias"))).status).toBe(200);
    expect((await fs(join(root, "missing"))).status).toBe(404);
    expect((await fs(join(outside, "missing"))).status).toBe(403);
    const run = (cwd: string) =>
      h(new Request("http://x/run", { method: "POST", body: JSON.stringify({ selection: { provider: "claude", model: "fake-1", cwd, access: "full" }, prompt: "go" }) }));
    expect((await run(join(root, "escape"))).status).toBe(403);
    expect((await run(join(root, "alias"))).status).toBe(200);
    rmSync(root, { recursive: true });
    rmSync(outside, { recursive: true });
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
  it("refuses other websites and rebound hosts when no token is set", async () => {
    const at = (headers: Record<string, string>) => call("/providers", { headers });
    expect((await at({ host: "127.0.0.1:4747", origin: "http://localhost:5173" })).status).toBe(200);
    expect((await at({ host: "[::1]:4747" })).status).toBe(200);
    expect((await at({ origin: "https://evil.example" })).status).toBe(403);
    expect((await at({ origin: "null" })).status).toBe(403);
    expect((await at({ host: "evil.example:4747" })).status).toBe(403);
    const run = await call("/run", { method: "POST", headers: { "content-type": "text/plain", origin: "https://evil.example" }, body: "{}" });
    expect(run.status).toBe(403);
  });

  it("accepts IP addresses and tailscale serve from the same page", async () => {
    const at = (headers: Record<string, string>) => call("/providers", { headers });
    expect((await at({ host: "100.64.0.7:4747", origin: "http://100.64.0.7:4747" })).status).toBe(200);
    expect((await at({ host: "192.168.1.20:4747" })).status).toBe(200);
    expect((await at({ host: "100.64.0.7:4747", origin: "http://100.64.0.9:4747" })).status).toBe(403);
    const tailnet = { host: "devbox.example.ts.net", "tailscale-user-login": "someone" };
    expect((await at({ ...tailnet, origin: "https://devbox.example.ts.net" })).status).toBe(200);
    expect((await at({ ...tailnet, origin: "https://other.example.ts.net" })).status).toBe(403);
    // Funnel requests and DNS rebinding have no tailnet user.
    expect((await at({ host: "devbox.example.ts.net" })).status).toBe(403);
    // A Funnel client can send any Host, so the Funnel marker refuses it even with a loopback Host.
    expect((await at({ host: "127.0.0.1:4747", "tailscale-funnel-request": "?1" })).status).toBe(403);
    const off = createHandler(funnel, { tailscale: false });
    expect((await off(new Request("http://x/providers", { headers: tailnet }))).status).toBe(403);
  });

  it("accepts allowedHosts and any origin once a token is set", async () => {
    const tailnet = createHandler(funnel, { allowedHosts: ["devbox.example.ts.net"] });
    const req = (headers: Record<string, string>) => new Request("http://x/providers", { headers });
    expect((await tailnet(req({ host: "devbox.example.ts.net", origin: "https://devbox.example.ts.net" }))).status).toBe(200);
    expect((await tailnet(req({ host: "other.example" }))).status).toBe(403);
    const suffix = createHandler(funnel, { allowedHosts: [".example.ts.net"] });
    expect((await suffix(req({ host: "devbox.example.ts.net" }))).status).toBe(200);
    expect((await suffix(req({ host: "devbox.example.ts.net.evil.example" }))).status).toBe(403);
    expect((await createHandler(funnel, { allowedHosts: ["*"] })(req({ host: "a.example", origin: "https://b.example" }))).status).toBe(200);
    const guarded = createHandler(funnel, { token: "s3cret" });
    expect((await guarded(req({ host: "devbox.example.ts.net", authorization: "Bearer s3cret" }))).status).toBe(200);
  });
});
