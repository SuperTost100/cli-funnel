import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createHandler } from "../src/server/handler.js";
import { createCwdGuard } from "../src/util/fs-roots.js";
import type { FunnelEvent, Provider } from "../src/types.js";

// A symlink can be swapped between the folder check and the process start. The run must get the path that was checked.
const seen: (string | undefined)[] = [];
const fake: Provider = {
  id: "claude",
  displayName: "Fake",
  capabilities: { access: ["accept-edits", "full"], effort: false, contextWindow: false, fast: false, resume: false, approvals: false, images: false, system: "prompt", schema: "prompt" },
  detect: async () => ({ installed: true, testedRange: { min: "1.0.0" } }),
  authStatus: async () => ({ loggedIn: true }),
  login: () => {
    throw new Error("no");
  },
  logout: async () => {},
  update: async () => ({ changed: false, output: "" }),
  models: async () => [{ id: "m", name: "M", provider: "claude", efforts: [], contextWindows: [], fast: false, source: "manifest" }],
  async *run(input): AsyncGenerator<FunnelEvent> {
    seen.push(input.selection.cwd);
    yield { type: "done", text: "ok", finishReason: "stop" };
  },
};

// realpath: on macOS tmpdir() sits behind the /var symlink.
const root = mkdtempSync(join(realpathSync(tmpdir()), "cf-canon-"));
mkdirSync(join(root, "inner"));
const inner = realpathSync(join(root, "inner"));
const alias = join(root, "alias");
// Windows needs a privilege for symlinks, so these checks run on the platforms that have them.
const symlinks = process.platform !== "win32";
if (symlinks) symlinkSync(inner, alias);
const dir = symlinks ? alias : inner;

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("cwd guard", () => {
  it("returns the canonical path, or undefined when the folder is refused", () => {
    const guard = createCwdGuard([root]);
    expect(guard(dir)).toBe(inner);
    expect(guard(join(root, "missing"))).toBeUndefined();
    expect(guard("relative")).toBeUndefined();
    expect(guard(tmpdir())).toBeUndefined();
  });
});

describe.skipIf(!symlinks)("the run gets the checked path, not the symlink", () => {
  const funnel = createFunnel({ providers: { claude: fake } });
  const post = (h: ReturnType<typeof createHandler>, path: string, body: unknown) =>
    h(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }));
  const plain = createHandler(funnel, { fsRoots: [root] });

  it("on POST /run", async () => {
    const res = await post(plain, "/run", { selection: { provider: "claude", model: "m", cwd: alias, access: "full" }, prompt: "go" });
    await res.text();
    expect(seen.at(-1)).toBe(inner);
  });

  it("on /v1/chat/completions with x_funnel.cwd", async () => {
    const res = await post(plain, "/v1/chat/completions", { model: "claude/m", messages: [{ role: "user", content: "hi" }], x_funnel: { cwd: alias } });
    await res.text();
    expect(seen.at(-1)).toBe(inner);
  });

  it("on /v1/responses with x_funnel.cwd", async () => {
    const res = await post(plain, "/v1/responses", { model: "claude/m", input: "hi", x_funnel: { cwd: alias } });
    await res.text();
    expect(seen.at(-1)).toBe(inner);
  });

  it("on the configured default openai.cwd", async () => {
    const h = createHandler(funnel, { fsRoots: [root], openai: { cwd: alias } });
    const res = await post(h, "/v1/chat/completions", { model: "claude/m", messages: [{ role: "user", content: "hi" }] });
    await res.text();
    expect(seen.at(-1)).toBe(inner);
  });

  it("in the MCP server", async () => {
    const s = createMcpServer({ funnel, fsRoots: [root], maxAccess: "full" });
    await s.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const res = await s.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run", arguments: { selection: { provider: "claude", model: "m", cwd: alias, access: "full" }, prompt: "hi" } },
    });
    expect(res?.result).not.toMatchObject({ isError: true });
    expect(seen.at(-1)).toBe(inner);
  });
});
