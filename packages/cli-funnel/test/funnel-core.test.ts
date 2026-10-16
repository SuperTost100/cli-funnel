import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createHandler } from "../src/server/handler.js";
import { collect, createRunFolder } from "../src/providers/base.js";
import { validateSelection } from "../src/selection.js";
import { FunnelError, type FunnelEvent, type Installation, type ModelInfo, type Provider, type RunInput } from "../src/types.js";

const model = (id: string, provider: Provider["id"] = "claude"): ModelInfo => ({
  id,
  name: id,
  provider,
  efforts: [],
  contextWindows: [],
  fast: false,
  source: "manifest",
});

const installed: Installation = { installed: true, testedRange: { min: "1.0.0" } };

function fakeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "claude",
    displayName: "Fake",
    binary: "fake",
    capabilities: { access: ["accept-edits"], effort: false, contextWindow: false, fast: false, resume: false, approvals: false, images: false, system: "prompt", schema: "prompt" },
    detect: async () => installed,
    authStatus: async () => ({ loggedIn: true }),
    login: () => {
      throw new Error("no");
    },
    logout: async () => {},
    update: async () => ({ changed: false, output: "" }),
    models: async () => [model("m1")],
    async *run(): AsyncGenerator<FunnelEvent> {
      yield { type: "text.delta", text: "hi" };
      yield { type: "done", text: "", finishReason: "stop" };
    },
    ...overrides,
  };
}

const selection = { provider: "claude", model: "m1", cwd: tmpdir(), access: "accept-edits" } as const;
const input = (extra: Partial<RunInput> = {}): RunInput => ({ selection, prompt: "hi", ...extra });

describe("stream() stopped early (#31)", () => {
  it("resolves .result as cancelled and closes the provider", async () => {
    let closed = false;
    const p = fakeProvider({
      async *run() {
        try {
          yield { type: "text.delta", text: "par" } as FunnelEvent;
          yield { type: "text.delta", text: "tial" } as FunnelEvent;
          yield { type: "done", text: "", finishReason: "stop" } as FunnelEvent;
        } finally {
          closed = true;
        }
      },
    });
    const s = createFunnel({ providers: { claude: p } }).stream(input());
    for await (const e of s) {
      expect(e.type).toBe("text.delta");
      break;
    }
    const result = await s.result;
    expect(result.finishReason).toBe("cancelled");
    expect(result.text).toBe("par");
    expect(closed).toBe(true);
  });

  it("keeps the provider's finish reason when the consumer stops after done", async () => {
    const s = createFunnel({ providers: { claude: fakeProvider() } }).stream(input());
    for await (const e of s) if (e.type === "done") break;
    expect((await s.result).finishReason).toBe("stop");
  });

  it("still rejects .result when the provider reports an error", async () => {
    const p = fakeProvider({
      async *run() {
        yield { type: "error", message: "boom", code: "cli-failed" } as FunnelEvent;
      },
    });
    const s = createFunnel({ providers: { claude: p } }).stream(input());
    const seen: string[] = [];
    for await (const e of s) seen.push(e.type);
    expect(seen).toEqual(["error"]);
    await expect(s.result).rejects.toThrow("boom");
  });
});

describe("run folder", () => {
  const events: FunnelEvent[] = [
    { type: "session", sessionId: "s1", model: "m2" },
    { type: "text.delta", text: "a" },
    { type: "tool.start", id: "t1", name: "Bash", input: { cmd: "ls" } },
    { type: "tool.end", id: "t1", error: "denied: Bash" },
    { type: "text.delta", text: "b" },
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    { type: "done", text: "", finishReason: "stop" },
  ];

  it("gives the same result incrementally as collect() gives for the whole stream", async () => {
    const folder = createRunFolder(input());
    for (const e of events) folder.add(e);
    const viaCollect = await collect(
      (async function* () {
        yield* events;
      })(),
      input(),
    );
    expect(folder.finish()).toEqual(viaCollect);
    expect(viaCollect).toMatchObject({ text: "ab", sessionId: "s1", model: "m2", deniedActions: ["Bash"] });
  });

  it("throws on an error event", () => {
    expect(() => createRunFolder(input()).add({ type: "error", message: "bad" })).toThrow("bad");
  });
});

describe("provider cache (#53)", () => {
  it("detects and lists models once across runs", async () => {
    const detect = vi.fn(async () => installed);
    const models = vi.fn(async () => [model("m1")]);
    const funnel = createFunnel({ providers: { claude: fakeProvider({ detect, models }) } });
    await funnel.run(input());
    await funnel.run(input());
    await funnel.models("claude");
    expect(detect).toHaveBeenCalledTimes(1);
    expect(models).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight call between concurrent runs", async () => {
    const detect = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return installed;
    });
    const funnel = createFunnel({ providers: { claude: fakeProvider({ detect }) } });
    await Promise.all([funnel.run(input()), funnel.run(input()), funnel.run(input())]);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("expires after 60 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const models = vi.fn(async () => [model("m1")]);
      const funnel = createFunnel({ providers: { claude: fakeProvider({ models }) } });
      await funnel.models("claude");
      vi.setSystemTime(Date.now() + 59_000);
      await funnel.models("claude");
      expect(models).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 2_000);
      await funnel.models("claude");
      expect(models).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache failures", async () => {
    const models = vi.fn<() => Promise<ModelInfo[]>>().mockRejectedValueOnce(new Error("down")).mockResolvedValue([model("m1")]);
    const funnel = createFunnel({ providers: { claude: fakeProvider({ models }) } });
    await expect(funnel.models("claude")).rejects.toThrow("down");
    expect((await funnel.models("claude")).map((m) => m.id)).toEqual(["m1"]);
    expect(models).toHaveBeenCalledTimes(2);
  });

  it("does not cache a CLI that is not installed", async () => {
    const detect = vi
      .fn<() => Promise<Installation>>()
      .mockResolvedValueOnce({ installed: false, testedRange: { min: "1.0.0" } })
      .mockResolvedValue(installed);
    const funnel = createFunnel({ providers: { claude: fakeProvider({ detect }) } });
    await expect(funnel.run(input())).rejects.toMatchObject({ code: "not-installed" });
    expect((await funnel.run(input())).text).toBe("hi");
  });

  it("refresh(id) drops one provider and refresh() drops all", async () => {
    const models = vi.fn(async () => [model("m1")]);
    const funnel = createFunnel({ providers: { claude: fakeProvider({ models }) } });
    await funnel.models("claude");
    funnel.refresh("claude");
    await funnel.models("claude");
    funnel.refresh();
    await funnel.models("claude");
    expect(models).toHaveBeenCalledTimes(3);
  });

  it("serves overview() from the same cache", async () => {
    const detect = vi.fn(async () => installed);
    // overview() probes every provider, so the built-in ones are faked too. Otherwise it runs the real CLIs and Ollama.
    const others = (["codex", "agent", "antigravity", "anthropic-api", "openai-api", "gemini-api", "ollama"] as const).map(
      (id) => [id, fakeProvider({ id, detect: async () => ({ installed: false, testedRange: { min: "0" } }) })] as const,
    );
    const funnel = createFunnel({ providers: { claude: fakeProvider({ detect }), ...Object.fromEntries(others) } });
    await funnel.run(input());
    const overview = await funnel.overview();
    expect(overview.find((o) => o.id === "claude")?.installation.installed).toBe(true);
    expect(detect).toHaveBeenCalledTimes(1);
  });
});

describe("manifestUrl (#44)", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function serveManifest(id: string): Promise<string> {
    const entry = { id, name: id, efforts: [], contextWindows: [], fast: false };
    const body = JSON.stringify({
      schemaVersion: 1,
      updated: "test",
      providers: { claude: [entry], codex: [entry], agent: [entry], antigravity: [entry] },
    });
    server = createServer((_, res) => res.setHeader("content-type", "application/json").end(body));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/models.json`;
  }

  it("adds the manifest's models to funnel.models()", async () => {
    const url = await serveManifest("claude-from-remote-1");
    expect((await createFunnel({ manifestUrl: url }).models("claude")).map((m) => m.id)).toContain("claude-from-remote-1");
    expect((await createFunnel().models("claude")).map((m) => m.id)).not.toContain("claude-from-remote-1");
  });

  it.skipIf(process.platform === "win32")("reaches codex, agent and antigravity when the CLI lists nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-fake-bin-"));
    const silent = join(dir, "silent");
    writeFileSync(silent, "#!/bin/sh\nexit 1\n");
    chmodSync(silent, 0o755);
    vi.stubEnv("CLI_FUNNEL_CODEX_BIN", silent);
    vi.stubEnv("CLI_FUNNEL_AGENT_BIN", silent);
    vi.stubEnv("CLI_FUNNEL_AGY_BIN", silent);
    try {
      const funnel = createFunnel({ manifestUrl: await serveManifest("from-remote-2") });
      for (const id of ["codex", "agent", "antigravity"] as const) {
        expect((await funnel.models(id)).map((m) => m.id)).toContain("from-remote-2");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes the URL to the provider when validating a run", async () => {
    const models = vi.fn(async (ctx?: { manifestUrl?: string }) => [model(ctx?.manifestUrl ? "only-with-url" : "m1")]);
    const funnel = createFunnel({ manifestUrl: "http://manifest.invalid/models.json", providers: { claude: fakeProvider({ models }) } });
    const result = await funnel.run(input({ selection: { ...selection, model: "only-with-url" } }));
    expect(result.text).toBe("hi");
  });
});

describe("selection without a machine (#45)", () => {
  const noMachine = fakeProvider({ capabilities: { ...fakeProvider().capabilities, access: [] } });

  it("accepts a provider without access levels when cwd and access are missing", () => {
    expect(() => validateSelection({ provider: "claude", model: "m1" }, noMachine)).not.toThrow();
  });

  it("requires cwd and access for a provider that lists access levels", () => {
    const p = fakeProvider();
    const attempt = (s: object) => () => validateSelection({ provider: "claude", model: "m1", ...s }, p);
    expect(attempt({ cwd: tmpdir() })).toThrow(FunnelError);
    expect(attempt({ access: "accept-edits" })).toThrow(/cwd/);
    expect(attempt({ cwd: tmpdir(), access: "accept-edits" })).not.toThrow();
  });

  it("runs a provider without access levels through the funnel", async () => {
    const funnel = createFunnel({ providers: { claude: noMachine } });
    const result = await funnel.run({ selection: { provider: "claude", model: "m1" }, prompt: "hi" });
    expect(result.text).toBe("hi");
  });

  it("still asks for onApproval when supervised on a provider with access levels", async () => {
    const funnel = createFunnel({ providers: { claude: fakeProvider({ capabilities: { ...fakeProvider().capabilities, access: ["supervised"] } }) } });
    await expect(funnel.run(input({ selection: { ...selection, access: "supervised" } }))).rejects.toMatchObject({ code: "invalid-selection" });
  });
});

describe("logout that keeps the account", () => {
  const keeps = () => createFunnel({ providers: { claude: fakeProvider({ authStatus: async () => ({ loggedIn: true }) }) } });

  it("rejects with cli-failed when the CLI still reports a signed-in account", async () => {
    await expect(keeps().logout("claude")).rejects.toMatchObject({ code: "cli-failed", message: expect.stringContaining("still reports a signed-in account") });
  });

  it("answers the HTTP route with an error instead of ok", async () => {
    const res = await createHandler(keeps())(new Request("http://x/providers/claude/logout", { method: "POST" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "cli-failed" });
  });

  it("resolves when the account is gone", async () => {
    const funnel = createFunnel({ providers: { claude: fakeProvider({ authStatus: async () => ({ loggedIn: false }) }) } });
    await expect(funnel.logout("claude")).resolves.toBeUndefined();
  });
});
