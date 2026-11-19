import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { memoryHistory } from "../src/providers/history.js";
import { responsesBody } from "../src/providers/responses.js";
import { createOpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { buildArgs as claudeArgs, claudeProvider } from "../src/providers/claude/index.js";
import { codexProvider } from "../src/providers/codex/index.js";
import { threadOptions } from "../src/providers/codex/options.js";
import { agentProvider, noneWorkspace as agentNone } from "../src/providers/agent/index.js";
import { antigravityProvider, noneWorkspace as agyNone } from "../src/providers/antigravity/index.js";
import { FunnelError, type FunnelEvent, type Provider, type RunInput } from "../src/types.js";
import { workspaceFor } from "../src/util/workspace.js";

const base = (over: Partial<RunInput> = {}, access: "none" | "auto" = "auto"): RunInput => ({
  selection: { provider: "claude", model: "m", cwd: "/tmp", access },
  prompt: "x",
  ...over,
});
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    if (e instanceof FunnelError) return e.code;
    throw e;
  }
};

describe("persist: false on the CLIs", () => {
  it("says which providers can leave no saved conversation", () => {
    expect(claudeProvider.capabilities.ephemeral).toBe(true);
    expect(codexProvider.capabilities.ephemeral).toBe(true);
    expect(agentProvider.capabilities.ephemeral).toBeFalsy();
    expect(antigravityProvider.capabilities.ephemeral).toBeFalsy();
  });

  it("passes --no-session-persistence to Claude Code, the same as providerOptions.claude.ephemeral", () => {
    expect(claudeArgs(base({ persist: false }))).toContain("--no-session-persistence");
    expect(claudeArgs(base({ providerOptions: { claude: { ephemeral: true } } }))).toContain("--no-session-persistence");
    expect(claudeArgs(base({ persist: true }))).not.toContain("--no-session-persistence");
    expect(claudeArgs(base())).not.toContain("--no-session-persistence");
  });

  it("starts an ephemeral Codex thread", () => {
    const codex = (over: Partial<RunInput>) => threadOptions({ ...base(over), selection: { provider: "codex", model: "m", cwd: "/tmp", access: "auto" } });
    expect(codex({ persist: false }).start).toEqual({ ephemeral: true });
    expect(codex({ persist: true }).start).toEqual({});
    expect(codex({ providerOptions: { codex: { ephemeral: true } } }).start).toEqual({ ephemeral: true });
  });

  it("refuses a resume and a conflicting pair, since an unsaved run cannot be resumed", () => {
    expect(code(() => claudeArgs(base({ persist: false, sessionId: "s1" })))).toBe("invalid-selection");
    expect(code(() => claudeArgs(base({ persist: false, providerOptions: { claude: { ephemeral: false } } })))).toBe("invalid-selection");
    expect(code(() => claudeArgs(base({ persist: true, providerOptions: { claude: { ephemeral: true } } })))).toBe("invalid-selection");
  });
});

describe("persist: false in the funnel", () => {
  const fake = (id: "claude" | "codex", ephemeral: boolean): Provider => ({
    id,
    displayName: ephemeral ? "Saves nothing" : "Saves everything",
    capabilities: { access: ["none"], effort: false, contextWindow: false, fast: false, resume: true, approvals: false, images: false, system: "prompt", schema: "prompt", ephemeral },
    detect: async () => ({ installed: true, testedRange: { min: "0" } }),
    authStatus: async () => ({ loggedIn: true }),
    login: () => { throw new Error("no"); },
    logout: async () => undefined,
    update: async () => ({ changed: false, output: "" }),
    models: async () => [{ id: "m", name: "M", provider: id, efforts: [], contextWindows: [], fast: false, source: "manifest" }],
    async *run(input: RunInput): AsyncGenerator<FunnelEvent> {
      yield { type: "done", text: String(input.persist), finishReason: "stop" };
    },
  });
  const funnel = createFunnel({ providers: { claude: fake("claude", true), codex: fake("codex", false) } });
  const run = (provider: "claude" | "codex", over: Partial<RunInput> = {}) =>
    funnel.run({ selection: { provider, model: "m", cwd: tmpdir(), access: "none" }, prompt: "x", ...over });

  it("passes persist to a provider that can honour it", async () => {
    expect((await run("claude", { persist: false })).text).toBe("false");
  });

  it("refuses a provider that saves every conversation, instead of saving it anyway", async () => {
    await expect(run("codex", { persist: false })).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("cannot run with persist: false") });
    expect((await run("codex", { persist: true })).text).toBe("true");
  });

  it("refuses persist: false with a sessionId, and a value that is not a boolean", async () => {
    await expect(run("claude", { persist: false, sessionId: "s1" })).rejects.toMatchObject({ code: "invalid-selection" });
    await expect(run("claude", { persist: "no" as never })).rejects.toMatchObject({ code: "invalid-selection" });
  });

  it("checks workspaceName", async () => {
    await expect(run("claude", { workspaceName: "../x" })).rejects.toMatchObject({ code: "invalid-selection" });
    await expect(run("claude", { workspaceName: "a".repeat(41) })).rejects.toMatchObject({ code: "invalid-selection" });
    expect((await run("claude", { workspaceName: "pyxis-1" })).text).toBe("undefined");
  });
});

describe("persist: false on a provider with history in cli-funnel's store", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = () =>
    new Response(
      [
        { type: "message_start", message: { usage: { input_tokens: 3 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );

  it("stores nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply()));
    const history = memoryHistory();
    const funnel = createFunnel({ apiKeys: { anthropic: "k" }, history, allowUnlistedModels: true });
    const selection = { provider: "anthropic-api" as const, model: "m", cwd: "/tmp", access: "full" as const };
    const kept = await funnel.run({ selection, prompt: "Hi." });
    const unsaved = await funnel.run({ selection, prompt: "Hi.", persist: false });
    expect(await history.get(`anthropic-api:${kept.sessionId}`)).toHaveLength(2);
    expect(await history.get(`anthropic-api:${unsaved.sessionId}`)).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("workspaceName", () => {
  it("gives each caller its own folder at none, and keeps the shared one by default", async () => {
    const home = mkdtempSync(join(tmpdir(), "cf-ws-"));
    vi.stubEnv("XDG_CACHE_HOME", home);
    try {
      expect(basename(await agentNone())).toBe("agent-none");
      expect(basename(await agentNone("pyxis"))).toBe("agent-none.pyxis");
      expect(basename(await agyNone("pyxis"))).toBe("antigravity-none.pyxis");
      expect(await agentNone("pyxis")).not.toBe(await agentNone("other"));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("persist: false on the Responses API", () => {
  const sel = { provider: "openai-api" as const, model: "gpt-5-pro", cwd: "/tmp", access: "full" as const };

  it("sends store: false, since OpenAI stores a response unless told not to", () => {
    expect(responsesBody({ selection: sel, prompt: "hi", persist: false })).toMatchObject({ store: false });
    expect(responsesBody({ selection: sel, prompt: "hi" })).not.toHaveProperty("store");
    expect(responsesBody({ selection: sel, prompt: "hi", persist: true })).not.toHaveProperty("store");
  });

  it("is refused on an OpenAI-compatible endpoint in responses mode, which may ignore store, and kept in chat mode", () => {
    const make = (mode?: "chat" | "responses") => createOpenAICompatibleProvider({ id: "local", name: "Local", baseUrl: "http://box:1/v1", ...(mode ? { mode } : {}) });
    expect(make("responses").capabilities.ephemeral).toBe(false);
    expect(make("chat").capabilities.ephemeral).toBe(true);
    expect(make().capabilities.ephemeral).toBe(true);
  });

  it("is refused by the funnel for such an endpoint, before any request", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (...a: unknown[]) => { calls.push(a); return new Response("{}"); }));
    try {
      const funnel = createFunnel({ openaiCompatible: [{ id: "local", name: "Local", baseUrl: "http://box:1/v1", mode: "responses" }], allowUnlistedModels: true });
      await expect(funnel.run({ selection: { provider: "openai-compatible:local", model: "m", cwd: "/tmp", access: "full" }, prompt: "hi", persist: false })).rejects.toMatchObject({ code: "unsupported" });
      expect(calls.filter((c) => String((c as string[])[0]).includes("/responses"))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("workspaceFor", () => {
  it("joins the parts with a character a caller's name cannot hold, so no two callers or kinds share a folder", () => {
    expect(workspaceFor("agent-none", undefined)).toBe("agent-none");
    expect(workspaceFor("agent-none", "pyxis")).toBe("agent-none.pyxis");
    const all = ["x", "mcp", "x-mcp", "a-b", "a_b"].map((n) => workspaceFor("agent-none", n));
    expect(new Set(all).size).toBe(all.length);
  });

  it("refuses a name that is not 1 to 40 letters, digits, _ or -, whoever calls it", () => {
    for (const bad of ["", "a.b", "../x", "a/b", "a b", "x".repeat(41), "é"]) expect(() => workspaceFor("agent-none", bad), bad).toThrow(FunnelError);
  });
});
