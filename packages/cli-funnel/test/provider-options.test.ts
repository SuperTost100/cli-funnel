import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArgs as agentArgs } from "../src/providers/agent/index.js";
import { buildArgs as agyArgs } from "../src/providers/antigravity/index.js";
import { buildArgs as claudeArgs } from "../src/providers/claude/index.js";
import { threadOptions } from "../src/providers/codex/options.js";
import { parseOpts, UsageError } from "../src/bin/run-input.js";
import { createFunnel } from "../src/funnel.js";
import { createHandler } from "../src/server/handler.js";
import { resolveOptionDirs } from "../src/server/openai.js";
import { validateProviderOptions } from "../src/selection.js";
import { ACCESS_LEVELS, FunnelError, type AccessLevel, type FunnelEvent, type Provider, type ProviderOptions, type RunInput } from "../src/types.js";

const input = (provider: RunInput["selection"]["provider"], access: AccessLevel, providerOptions: unknown, extra: Partial<RunInput> = {}): RunInput => ({
  selection: { provider, model: "m", cwd: "/tmp", access },
  prompt: "x",
  onApproval: () => "deny",
  providerOptions: providerOptions as ProviderOptions,
  ...extra,
});

/** The FunnelError code a call throws, or "ok". */
const outcome = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    if (e instanceof FunnelError) return e.code;
    throw e;
  }
};

/** Which access levels accept the options. */
const acceptedAt = (fn: (access: AccessLevel) => unknown) => ACCESS_LEVELS.filter((a) => outcome(() => fn(a)) === "ok");

describe("claude providerOptions", () => {
  const args = (access: AccessLevel, opts: unknown, extra?: Partial<RunInput>) => claudeArgs(input("claude", access, { claude: opts }, extra));

  it("maps every option to its flag in --flag=value form", () => {
    const a = args("full", {
      allowedTools: ["Bash(git *)", "Edit"],
      disallowedTools: ["WebFetch"],
      addDirs: ["/srv/a", "/srv/b"],
      mcpConfig: { mcpServers: { x: { command: "x" } } },
      agents: { reviewer: { description: "Reviews", prompt: "Review it", tools: ["Read"] } },
      fallbackModel: "claude-sonnet-5",
      maxBudgetUsd: 0.5,
      forkSession: true,
      betas: ["b1"],
    }, { sessionId: "s1" });
    expect(a).toEqual(expect.arrayContaining([
      "--allowed-tools=Bash(git *)",
      "--allowed-tools=Edit",
      "--disallowed-tools=WebFetch",
      "--add-dir=/srv/a",
      "--add-dir=/srv/b",
      '--mcp-config={"mcpServers":{"x":{"command":"x"}}}',
      '--agents={"reviewer":{"description":"Reviews","prompt":"Review it","tools":["Read"]}}',
      "--fallback-model=claude-sonnet-5",
      "--max-budget-usd=0.5",
      "--fork-session",
      "--betas=b1",
    ]));
    expect(a).not.toContain("--bare");
  });

  it("adds nothing without options", () => {
    expect(args("auto", undefined)).toEqual(claudeArgs(input("claude", "auto", undefined)));
  });

  it("accepts each option only at the levels it cannot widen", () => {
    const agents = { r: { description: "d", prompt: "p" } };
    expect(acceptedAt((a) => args(a, { allowedTools: ["Bash"] }))).toEqual(["full"]);
    expect(acceptedAt((a) => args(a, { mcpConfig: { mcpServers: {} } }))).toEqual(["full"]);
    expect(acceptedAt((a) => args(a, { addDirs: ["/srv"] }))).toEqual(["supervised", "accept-edits", "auto", "full"]);
    expect(acceptedAt((a) => args(a, { agents }))).toEqual(["supervised", "accept-edits", "auto", "full"]);
    for (const opts of [{ disallowedTools: ["Bash"] }, { fallbackModel: "m2" }, { maxBudgetUsd: 1 }, { betas: ["b"] }]) {
      expect(acceptedAt((a) => args(a, opts))).toEqual([...ACCESS_LEVELS]);
    }
  });

  it("keeps none text-only whatever the options say", () => {
    const a = args("none", { disallowedTools: ["Bash"] });
    expect(a).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--setting-sources", ""]));
    expect(a.some((x) => x.startsWith("--add-dir") || x.startsWith("--mcp-config") || x.startsWith("--allowed-tools"))).toBe(false);
  });

  it("refuses subagent keys that could widen access", () => {
    for (const key of ["permissionMode", "mcpServers", "hooks"]) {
      expect(outcome(() => args("auto", { agents: { r: { description: "d", prompt: "p", [key]: "x" } } }))).toBe("invalid-selection");
    }
    expect(outcome(() => args("auto", { agents: { r: { description: "d" } } }))).toBe("invalid-selection");
  });

  it("refuses bad values, unknown keys and a fork without a session", () => {
    expect(outcome(() => args("full", { addDirs: ["relative/dir"] }))).toBe("invalid-selection");
    expect(outcome(() => args("full", { addDir: ["/srv"] }))).toBe("invalid-selection");
    expect(outcome(() => args("full", { maxBudgetUsd: "5" }))).toBe("invalid-selection");
    expect(outcome(() => args("full", { maxBudgetUsd: 0 }))).toBe("invalid-selection");
    expect(outcome(() => args("full", { betas: [1] }))).toBe("invalid-selection");
    expect(outcome(() => args("full", { mcpConfig: "/path/to/file.json" }))).toBe("invalid-selection");
    expect(outcome(() => args("full", { forkSession: true }))).toBe("invalid-selection");
    expect(outcome(() => args("full", "not an object"))).toBe("invalid-selection");
  });

  it("takes a single string where a list is expected", () => {
    expect(args("auto", { addDirs: "/srv" })).toContain("--add-dir=/srv");
  });

  it("ignores options keyed by another provider", () => {
    const a = claudeArgs(input("claude", "none", { codex: { webSearch: "live" }, agent: { addDirs: ["/srv"] } }));
    expect(a).toEqual(claudeArgs(input("claude", "none", undefined)));
  });
});

describe("codex providerOptions", () => {
  const opts = (access: AccessLevel, o: unknown, extra?: Partial<RunInput>) => threadOptions(input("codex", access, { codex: o }, extra));

  it("maps ephemeral, web search and approval policy", () => {
    expect(opts("auto", { ephemeral: true, webSearch: "live", approvalPolicy: "untrusted" })).toEqual({
      start: { ephemeral: true },
      config: { web_search: "live" },
      approvalPolicy: "untrusted",
    });
    expect(opts("auto", undefined)).toEqual({ start: {}, config: {} });
  });

  it("only accepts approval policies that ask at least as often as the level", () => {
    expect(acceptedAt((a) => opts(a, { approvalPolicy: "untrusted" }))).toEqual([...ACCESS_LEVELS]);
    expect(acceptedAt((a) => opts(a, { approvalPolicy: "on-request" }))).toEqual(["auto", "full"]);
    expect(acceptedAt((a) => opts(a, { approvalPolicy: "never" }))).toEqual(["full"]);
    expect(outcome(() => opts("auto", { approvalPolicy: { granular: {} } }))).toBe("invalid-selection");
  });

  it("allows web search off at none and nothing else", () => {
    expect(acceptedAt((a) => opts(a, { webSearch: "live" }))).toEqual(["auto", "full"]);
    expect(acceptedAt((a) => opts(a, { webSearch: "cached" }))).toEqual(["supervised", "accept-edits", "auto", "full"]);
    expect(acceptedAt((a) => opts(a, { webSearch: "indexed" }))).toEqual(["supervised", "accept-edits", "auto", "full"]);
    expect(acceptedAt((a) => opts(a, { webSearch: "disabled" }))).toEqual([...ACCESS_LEVELS]);
    expect(opts("none", { webSearch: "disabled" }).config).toEqual({});
  });

  it("refuses ephemeral on a resumed thread and unknown keys", () => {
    expect(outcome(() => opts("auto", { ephemeral: true }, { sessionId: "t1" }))).toBe("invalid-selection");
    expect(outcome(() => opts("auto", { sandbox: "danger-full-access" }))).toBe("invalid-selection");
    expect(outcome(() => opts("auto", { config: { web_search: "live" } }))).toBe("invalid-selection");
  });
});

describe("agent providerOptions", () => {
  const args = (access: AccessLevel, o: unknown) => agentArgs(input("agent", access, { agent: o }), "m");
  const modes = (a: string[]) => a.flatMap((x, i) => (x === "--mode" ? [a[i + 1]] : []));

  it("maps add-dir and sandbox", () => {
    expect(args("auto", { addDirs: ["/srv"], sandbox: "enabled" })).toEqual(expect.arrayContaining(["--add-dir=/srv", "--sandbox=enabled"]));
    expect(args("full", { sandbox: "disabled" })).toContain("--sandbox=disabled");
  });

  it("refuses add-dir at none and a disabled sandbox below full", () => {
    // agent offers none, auto and full. The other levels fail in accessFlags.
    expect(acceptedAt((a) => args(a, { addDirs: ["/srv"] }))).toEqual(["auto", "full"]);
    expect(acceptedAt((a) => args(a, { sandbox: "disabled" }))).toEqual(["full"]);
    expect(acceptedAt((a) => args(a, { sandbox: "enabled" }))).toEqual(["none", "auto", "full"]);
  });

  it("refuses plan mode at none, which keeps ask mode", () => {
    expect(acceptedAt((a) => args(a, { mode: "plan" }))).toEqual(["auto", "full"]);
    expect(modes(args("none", {}))).toEqual(["ask"]);
    const auto = args("auto", { mode: "plan" });
    expect(modes(auto)).toEqual(["plan"]);
    expect(auto).toContain("--auto-review");
    expect(outcome(() => args("auto", { mode: "ask" }))).toBe("invalid-selection");
  });
});

describe("antigravity providerOptions", () => {
  const args = (access: AccessLevel, o: unknown) => agyArgs(input("antigravity", access, { antigravity: o }));

  it("maps add-dir and the print timeout", () => {
    expect(args("accept-edits", { addDirs: ["/srv"], printTimeoutSec: 30 })).toEqual(expect.arrayContaining(["--add-dir=/srv", "--print-timeout=30s"]));
  });

  it("refuses add-dir at none", () => {
    expect(outcome(() => args("none", { addDirs: ["/srv"] }))).toBe("invalid-selection");
    expect(args("none", { printTimeoutSec: 5 })).toContain("--print-timeout=5s");
    expect(outcome(() => args("full", { printTimeoutSec: -1 }))).toBe("invalid-selection");
  });
});

describe("cli --opt", () => {
  it("parses JSON values, keeps text and collects repeated keys", () => {
    expect(parseOpts("claude", ["addDirs=/a", "addDirs=/b", "maxBudgetUsd=2", "forkSession=true", "fallbackModel=claude-sonnet-5"])).toEqual({
      claude: { addDirs: ["/a", "/b"], maxBudgetUsd: 2, forkSession: true, fallbackModel: "claude-sonnet-5" },
    });
    expect(parseOpts("codex", ['webSearch="live"'])).toEqual({ codex: { webSearch: "live" } });
    expect(parseOpts("claude", [])).toBeUndefined();
    expect(() => parseOpts("claude", ["novalue"])).toThrow(UsageError);
    expect(() => parseOpts("claude", ["=x"])).toThrow(UsageError);
  });
});

describe("providerOptions keys", () => {
  it("accepts the CLI providers and refuses the rest", () => {
    expect(outcome(() => validateProviderOptions({ claude: {}, codex: {}, agent: {}, antigravity: {} }))).toBe("ok");
    expect(outcome(() => validateProviderOptions({ ollama: {} }))).toBe("invalid-selection");
    expect(outcome(() => validateProviderOptions([]))).toBe("invalid-selection");
  });
});

describe("providerOptions through the server", () => {
  const seen: (ProviderOptions | undefined)[] = [];
  const fake: Provider = {
    id: "claude",
    displayName: "Fake",
    binary: "fake",
    capabilities: { access: ["accept-edits", "full"], effort: false, contextWindow: false, fast: false, resume: true, approvals: false, images: false, system: "prompt", schema: "prompt" },
    detect: async () => ({ installed: true, testedRange: { min: "1.0.0" } }),
    authStatus: async () => ({ loggedIn: true }),
    login: () => {
      throw new Error("no");
    },
    logout: async () => {},
    update: async () => ({ changed: false, output: "" }),
    models: async () => [{ id: "m", name: "M", provider: "claude", efforts: [], contextWindows: [], fast: false, source: "manifest" }],
    async *run(input): AsyncGenerator<FunnelEvent> {
      seen.push(input.providerOptions);
      yield { type: "done", text: "ok", finishReason: "stop" };
    },
  };
  const root = mkdtempSync(join(tmpdir(), "cf-opt-root-"));
  const outside = mkdtempSync(join(tmpdir(), "cf-opt-out-"));
  symlinkSync(outside, join(root, "escape"));
  const h = createHandler(createFunnel({ providers: { claude: fake } }), { fsRoots: [root], openai: { cwd: root } });
  const post = (path: string, body: unknown) => h(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }));
  const run = (addDirs: unknown) =>
    post("/run", { selection: { provider: "claude", model: "m", cwd: root, access: "full" }, prompt: "go", providerOptions: { claude: { addDirs } } });
  const chat = (addDirs: unknown) =>
    post("/v1/chat/completions", { model: "claude/m", messages: [{ role: "user", content: "hi" }], x_funnel: { providerOptions: { claude: { addDirs } } } });
  const responses = (addDirs: unknown) => post("/v1/responses", { model: "claude/m", input: "hi", x_funnel: { providerOptions: { claude: { addDirs } } } });

  it("checks addDirs against fsRoots like cwd", async () => {
    expect((await run([outside])).status).toBe(403);
    expect((await run(join(root, "escape"))).status).toBe(403);
    expect((await run(["/definitely/missing"])).status).toBe(403);
    expect((await chat([outside])).status).toBe(403);
    expect((await chat(outside)).status).toBe(403);
    const ok = await run([root]);
    expect(ok.status).toBe(200);
    await ok.text();
    expect(seen.at(-1)).toEqual({ claude: { addDirs: [realpathSync(root)] } });
    expect((await chat([root])).status).toBe(200);
    expect(seen.at(-1)).toEqual({ claude: { addDirs: [realpathSync(root)] } });
  });

  it("checks addDirs on /v1/responses with the same rule", async () => {
    const refused = await responses([outside]);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.message).toContain("addDirs");
    expect((await responses(join(root, "escape"))).status).toBe(403);
    expect((await responses([root])).status).toBe(200);
    expect(seen.at(-1)).toEqual({ claude: { addDirs: [realpathSync(root)] } });
  });

  it("hands the provider the checked real path, not the symlink", async () => {
    // A symlink the request names could be pointed elsewhere after the check. The run gets the path it resolved to.
    mkdirSync(join(root, "inner"));
    symlinkSync(join(root, "inner"), join(root, "alias"));
    const inner = realpathSync(join(root, "inner"));
    const ok = await run(join(root, "alias"));
    expect(ok.status).toBe(200);
    await ok.text();
    expect(seen.at(-1)).toEqual({ claude: { addDirs: [inner] } });
    expect((await chat([join(root, "alias")])).status).toBe(200);
    expect(seen.at(-1)).toEqual({ claude: { addDirs: [inner] } });
    expect(resolveOptionDirs({ claude: { addDirs: ["relative"] } }, () => true)).toBeNull();
    expect(resolveOptionDirs(undefined, () => false)).toBeUndefined();
  });

  it("answers 400 for providerOptions keyed by a provider that takes none", async () => {
    const res = await post("/v1/chat/completions", { model: "claude/m", messages: [{ role: "user", content: "hi" }], x_funnel: { providerOptions: { ollama: {} } } });
    expect(res.status).toBe(400);
    rmSync(root, { recursive: true });
    rmSync(outside, { recursive: true });
  });
});
