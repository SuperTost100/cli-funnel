import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createMcpServer, serveStdio } from "../src/mcp/server.js";
import type { AccessLevel, FunnelEvent, Provider, ProviderId } from "../src/types.js";

const seen: { access?: AccessLevel; cwd?: string; system?: string; schema?: boolean }[] = [];

const fake: Provider = {
  id: "claude",
  displayName: "Fake",
  binary: "fake",
  capabilities: { access: ["none", "supervised", "accept-edits", "full"], effort: true, contextWindow: false, fast: false, resume: true, approvals: true, images: false, system: "prompt", schema: "prompt" },
  detect: async () => ({ installed: true, testedRange: { min: "1.0.0" }, version: "1.0.0", withinTestedRange: true }),
  authStatus: async () => ({ loggedIn: true }),
  login: () => {
    throw new Error("no");
  },
  logout: async () => {},
  update: async () => ({ changed: false, output: "" }),
  models: async () => [
    { id: "fake-1", name: "Fake 1", provider: "claude", efforts: [{ id: "high", label: "High" }], contextWindows: [], fast: false, source: "manifest" },
  ],
  async *run(input): AsyncGenerator<FunnelEvent> {
    seen.push({ access: input.selection.access, cwd: input.selection.cwd, system: input.system, schema: !!input.responseSchema });
    if (input.prompt === "boom") {
      yield { type: "error", message: "the CLI crashed" };
      return;
    }
    yield { type: "session", sessionId: "s1" };
    if (input.responseSchema) {
      yield { type: "structured", data: { answer: 42 } };
      yield { type: "done", text: '{"answer":42}', finishReason: "stop" };
      return;
    }
    yield { type: "text.delta", text: "hel" };
    yield { type: "text.delta", text: "lo" };
    yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
    yield { type: "done", text: "", finishReason: "stop" };
  },
};

// Every built-in provider is replaced. Otherwise list_providers probes the real CLIs and Ollama: `agent status` and the
// `agy` auth check take 1 to 2 s each, which crosses vitest's 5 s limit when the suite runs in parallel.
const empty = (id: ProviderId): Provider => ({ ...fake, id, models: async () => [] });
const funnel = createFunnel({
  providers: {
    claude: fake,
    codex: empty("codex"),
    agent: empty("agent"),
    antigravity: empty("antigravity"),
    "anthropic-api": empty("anthropic-api"),
    "openai-api": empty("openai-api"),
    "gemini-api": empty("gemini-api"),
    ollama: empty("ollama"),
  },
});
const root = mkdtempSync(join(tmpdir(), "cf-mcp-"));
const project = join(root, "project");
mkdirSync(project);

const initialize = (protocolVersion = "2025-06-18") => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "0" } },
});
const callRun = (args: object, id = 2) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "run", arguments: args } });
const selection = (extra: object = {}) => ({ provider: "claude", model: "fake-1", cwd: project, ...extra });

function server(options: { maxAccess?: AccessLevel } = {}) {
  return createMcpServer({ funnel, fsRoots: [root], cwd: project, version: "9.9.9", ...options });
}

describe("mcp handshake", () => {
  it("answers initialize with the requested version and the tools capability", async () => {
    const res = await server().handle(initialize());
    expect(res).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cli-funnel", version: "9.9.9" } },
    });
  });

  it("offers its newest version when the client asks for one it does not know", async () => {
    const res = await server().handle(initialize("1999-01-01"));
    expect(res?.result).toMatchObject({ protocolVersion: "2025-11-25" });
  });

  it("sends no reply to notifications and answers ping", async () => {
    const s = server();
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(await s.handle({ jsonrpc: "2.0", id: 7, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("answers an unknown method with -32601 and a malformed message with -32600", async () => {
    const s = server();
    expect((await s.handle({ jsonrpc: "2.0", id: 1, method: "resources/list" }))?.error?.code).toBe(-32601);
    expect((await s.handle({ hello: "world" }))?.error?.code).toBe(-32600);
  });

  it("lists the three tools", async () => {
    const res = await server().handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (res?.result as { tools: { name: string; inputSchema: { type: string } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["list_providers", "list_models", "run"]);
    expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
  });

  it("answers an unknown tool with -32602", async () => {
    const res = await server().handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } });
    expect(res?.error?.code).toBe(-32602);
  });
});

describe("mcp tools", () => {
  it("list_providers reports installed providers and the access cap", async () => {
    const s = server({ maxAccess: "accept-edits" });
    await s.handle(initialize());
    const res = await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_providers", arguments: {} } });
    const sc = (res?.result as { structuredContent: { providers: { id: string; installed: boolean }[]; maxAccess: string } }).structuredContent;
    expect(sc.maxAccess).toBe("accept-edits");
    expect(sc.providers.find((p) => p.id === "claude")).toMatchObject({ installed: true });
  });

  it("list_models returns the provider's models, and an unknown provider is a tool error", async () => {
    const s = server();
    await s.handle(initialize());
    const ok = await s.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_models", arguments: { provider: "claude" } } });
    expect((ok?.result as { structuredContent: { models: { id: string }[] } }).structuredContent.models[0]?.id).toBe("fake-1");
    const bad = await s.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_models", arguments: { provider: "nope" } } });
    expect(bad?.result).toMatchObject({ isError: true });
  });

  it("run returns the text, usage and session id", async () => {
    const s = server();
    await s.handle(initialize());
    const res = await s.handle(callRun({ selection: selection(), prompt: "hi", system: "be brief" }));
    expect(res?.result).toMatchObject({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { text: "hello", provider: "claude", model: "fake-1", sessionId: "s1", finishReason: "stop", usage: { totalTokens: 5 } },
    });
    expect((res?.result as { isError?: boolean }).isError).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({ access: "none", system: "be brief" });
  });

  it("run with responseSchema returns the parsed answer in structured", async () => {
    const s = server();
    await s.handle(initialize());
    const res = await s.handle(callRun({ selection: selection(), prompt: "hi", responseSchema: { schema: { type: "object" } } }));
    expect(res?.result).toMatchObject({ structuredContent: { structured: { answer: 42 } } });
    expect(seen.at(-1)?.schema).toBe(true);
  });

  it("run leaves structuredContent out for a client on an older revision", async () => {
    const s = server();
    await s.handle(initialize("2024-11-05"));
    const res = await s.handle(callRun({ selection: selection(), prompt: "hi" }));
    expect(res?.result).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("run uses the server's folder when the selection has no cwd", async () => {
    const s = server();
    await s.handle(initialize());
    await s.handle(callRun({ selection: { provider: "claude", model: "fake-1" }, prompt: "hi" }));
    expect(seen.at(-1)?.cwd).toBe(project);
  });

  it("run turns a failing provider into an isError result", async () => {
    const s = server();
    await s.handle(initialize());
    const res = await s.handle(callRun({ selection: selection(), prompt: "boom" }));
    expect(res?.result).toMatchObject({ isError: true, content: [{ text: "the CLI crashed" }] });
  });

  it("run refuses an unknown model and bad arguments without calling the provider", async () => {
    const s = server();
    await s.handle(initialize());
    const before = seen.length;
    const model = await s.handle(callRun({ selection: selection({ model: "nope" }), prompt: "hi" }));
    expect(model?.result).toMatchObject({ isError: true });
    const noPrompt = await s.handle(callRun({ selection: selection() }));
    expect(noPrompt?.result).toMatchObject({ isError: true, content: [{ text: "prompt must be a non-empty string." }] });
    expect(seen.length).toBe(before);
  });
});

describe("mcp access cap", () => {
  it("refuses a run above --max-access instead of lowering it", async () => {
    const s = server({ maxAccess: "none" });
    await s.handle(initialize());
    const before = seen.length;
    const res = await s.handle(callRun({ selection: selection({ access: "full" }), prompt: "hi" }));
    expect(res?.result).toMatchObject({ isError: true });
    expect((res?.result as { content: { text: string }[] }).content[0]!.text).toContain('above this server\'s --max-access "none"');
    expect(seen.length).toBe(before);
  });

  it("allows a run at or below the cap", async () => {
    const s = server({ maxAccess: "accept-edits" });
    await s.handle(initialize());
    for (const access of ["none", "accept-edits"] as const) {
      const res = await s.handle(callRun({ selection: selection({ access }), prompt: "hi" }));
      expect((res?.result as { isError?: boolean }).isError).toBeUndefined();
      expect(seen.at(-1)?.access).toBe(access);
    }
  });

  it("refuses supervised even when the cap would allow it", async () => {
    const s = server({ maxAccess: "full" });
    await s.handle(initialize());
    const before = seen.length;
    const res = await s.handle(callRun({ selection: selection({ access: "supervised" }), prompt: "hi" }));
    expect(res?.result).toMatchObject({ isError: true });
    expect(seen.length).toBe(before);
  });

  it("refuses an access level that does not exist", async () => {
    const s = server();
    await s.handle(initialize());
    const res = await s.handle(callRun({ selection: selection({ access: "root" }), prompt: "hi" }));
    expect(res?.result).toMatchObject({ isError: true });
  });
});

describe("mcp folder roots", () => {
  it("refuses a cwd outside the roots, a relative one and one that does not exist", async () => {
    const s = server();
    await s.handle(initialize());
    const before = seen.length;
    for (const cwd of [tmpdir(), "relative/dir", join(root, "missing")]) {
      const res = await s.handle(callRun({ selection: selection({ cwd }), prompt: "hi" }));
      expect(res?.result).toMatchObject({ isError: true });
      expect((res?.result as { content: { text: string }[] }).content[0]!.text).toContain("outside the allowed folders");
    }
    expect(seen.length).toBe(before);
  });

  it("refuses a symlink inside a root that points outside it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cf-mcp-out-"));
    const link = join(root, "link");
    symlinkSync(outside, link);
    const s = server();
    await s.handle(initialize());
    const res = await s.handle(callRun({ selection: selection({ cwd: link }), prompt: "hi" }));
    expect(res?.result).toMatchObject({ isError: true });
  });
});

describe("mcp stdio", () => {
  it("serves newline-delimited JSON and writes only protocol messages to the output", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (c) => (written += c));
    const done = serveStdio(server(), input, output);
    input.write(JSON.stringify(initialize()) + "\n");
    input.write("not json\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n\n");
    input.write(JSON.stringify(callRun({ selection: selection(), prompt: "hi" }, 5)) + "\n");
    input.end();
    await done;
    const lines = written.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.every((l) => l.jsonrpc === "2.0")).toBe(true);
    expect(lines.map((l) => l.id).sort()).toEqual([1, 5, null].sort());
    expect(lines.find((l) => l.id === null).error.code).toBe(-32700);
    expect(lines.find((l) => l.id === 5).result.content[0].text).toBe("hello");
  });

  it("aborts a run when the client sends notifications/cancelled", async () => {
    let aborted = false;
    const slow: Provider = {
      ...fake,
      async *run(input) {
        await new Promise<void>((resolve) =>
          input.signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }),
        );
        yield { type: "done", text: "", finishReason: "cancelled" };
      },
    };
    const s = createMcpServer({ funnel: createFunnel({ providers: { claude: slow } }), fsRoots: [root], cwd: project });
    const reply = s.handle(callRun({ selection: selection(), prompt: "hi" }, 9));
    await new Promise((r) => setTimeout(r, 20));
    await s.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
    await reply;
    expect(aborted).toBe(true);
  });
});
