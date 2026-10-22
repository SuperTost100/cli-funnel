import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { FunnelEvent, Provider } from "../src/types.js";

const seen: (string | undefined)[] = [];

// A provider with no access levels, like Ollama and the API providers. It has no machine to protect and ignores cwd.
const noAccess: Provider = {
  id: "ollama",
  displayName: "Fake",
  binary: "fake",
  capabilities: { access: [], effort: false, contextWindow: false, fast: false, resume: false, approvals: false, images: false, system: "prompt", schema: "prompt" },
  detect: async () => ({ installed: true, testedRange: { min: "1.0.0" }, version: "1.0.0", withinTestedRange: true }),
  authStatus: async () => ({ loggedIn: true }),
  login: () => {
    throw new Error("no");
  },
  logout: async () => {},
  update: async () => ({ changed: false, output: "" }),
  models: async () => [{ id: "m", name: "M", provider: "ollama", efforts: [], contextWindows: [], fast: false, source: "manifest" }],
  async *run(input): AsyncGenerator<FunnelEvent> {
    seen.push(input.selection.cwd);
    yield { type: "text.delta", text: "ok" };
    yield { type: "done", text: "ok", finishReason: "stop" };
  },
};

const root = mkdtempSync(join(tmpdir(), "cf-mcp-cwd-"));
const project = join(root, "project");
mkdirSync(project);

const call = (selection: object) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "run", arguments: { selection: { provider: "ollama", model: "m", ...selection }, prompt: "hi" } },
});

describe("mcp cwd on a provider with no access levels", () => {
  const server = () => createMcpServer({ funnel: createFunnel({ providers: { ollama: noAccess } }), fsRoots: [root], cwd: project });

  it("does not refuse a cwd outside the roots, as the HTTP handler does not", async () => {
    const outside = tmpdir();
    const res = await server().handle(call({ cwd: outside }));
    expect(res?.result).not.toMatchObject({ isError: true });
    expect(seen.at(-1)).toBe(outside);
  });

  it("still refuses a cwd that is not a string", async () => {
    const res = await server().handle(call({ cwd: 42 }));
    expect(res?.result).toMatchObject({ isError: true });
  });
});
