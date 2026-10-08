import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { collect } from "../src/providers/base.js";
import { buildPrompt as agentPrompt } from "../src/providers/agent/index.js";
import { buildArgs as agyArgs } from "../src/providers/antigravity/index.js";
import { createMapper } from "../src/providers/antigravity/parser.js";
import { buildArgs as claudeArgs, userContent } from "../src/providers/claude/index.js";
import { parseClaudeMessage } from "../src/providers/claude/parser.js";
import { planAccess } from "../src/providers/codex/access.js";
import { createApiProviders } from "../src/providers/api.js";
import { composePrompt, parseJsonAnswer } from "../src/providers/prompt.js";
import { createHandler } from "../src/server/handler.js";
import type { FunnelEvent, Provider, RunInput, Selection } from "../src/types.js";

const IMAGE = { type: "image" as const, mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
const SCHEMA = { schema: { type: "object", properties: { word: { type: "string" } }, required: ["word"], additionalProperties: false } };

const input = (selection: Partial<Selection>, over: Partial<RunInput> = {}): RunInput => ({
  selection: { provider: "claude", model: "m", cwd: "/tmp", access: "none", ...selection },
  prompt: "Give the word ok.",
  ...over,
});

async function* events(list: FunnelEvent[]) {
  yield* list;
}

describe("composePrompt and parseJsonAnswer", () => {
  it("wraps instructions and appends the schema request", () => {
    const text = composePrompt({ prompt: "Q", system: "Be terse.", responseSchema: SCHEMA }, { system: true, schema: true });
    expect(text.startsWith("<instructions>\nBe terse.\n</instructions>\n\nQ\n\n")).toBe(true);
    expect(text).toContain('"additionalProperties":false');
    expect(composePrompt({ prompt: "Q", system: "S" }, { system: false, schema: true })).toBe("Q");
  });

  it("parses JSON with or without a fence", () => {
    expect(parseJsonAnswer('{"word":"ok"}')).toEqual({ word: "ok" });
    expect(parseJsonAnswer('```json\n{"word":"ok"}\n```')).toEqual({ word: "ok" });
    expect(() => parseJsonAnswer("ok")).toThrow();
  });
});

describe("collect with responseSchema", () => {
  it("prefers the provider's structured event", async () => {
    const r = await collect(
      events([{ type: "structured", data: { word: "ok" } }, { type: "done", text: "not json", finishReason: "stop" }]),
      input({}, { responseSchema: SCHEMA }),
    );
    expect(r.structured).toEqual({ word: "ok" });
  });

  it("parses the text when no event came, and explains a failure", async () => {
    const ok = await collect(events([{ type: "done", text: '{"word":"ok"}', finishReason: "stop" }]), input({}, { responseSchema: SCHEMA }));
    expect(ok.structured).toEqual({ word: "ok" });
    const bad = await collect(events([{ type: "done", text: "ok", finishReason: "stop" }]), input({}, { responseSchema: SCHEMA }));
    expect(bad.structured).toBeUndefined();
    expect(bad.structuredError).toMatch(/not JSON/);
  });
});

describe("claude", () => {
  it("removes tools, settings and MCP servers for none, and replaces the system prompt", () => {
    const args = claudeArgs(input({}, { system: "Be terse.", responseSchema: SCHEMA }));
    expect(args).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--setting-sources", "--system-prompt", "Be terse.", "--json-schema"]));
    expect(args).not.toContain("--permission-prompt-tool");
  });

  it("appends the system prompt at other levels", () => {
    const args = claudeArgs(input({ access: "accept-edits" }, { system: "Be terse." }));
    expect(args).toContain("--append-system-prompt");
    expect(args).not.toContain("--tools");
  });

  it("sends images as content blocks", () => {
    expect(userContent(input({}))).toBe("Give the word ok.");
    expect(userContent(input({}, { attachments: [IMAGE] }))).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE.data } },
      { type: "text", text: "Give the word ok." },
    ]);
  });

  it("reads structured_output from the result", () => {
    const ev = parseClaudeMessage({ type: "result", subtype: "success", result: '{"word":"ok"}', structured_output: { word: "ok" }, usage: {} });
    expect(ev).toContainEqual({ type: "structured", data: { word: "ok" } });
  });
});

describe("codex", () => {
  it("plans none as a read-only sandbox", () => {
    expect(planAccess("none")).toMatchObject({ sandbox: "read-only", autoAllowFileChanges: false });
  });
});

describe("cursor agent", () => {
  it("puts the system prompt and the schema request into the prompt", () => {
    const prompt = agentPrompt(input({ provider: "agent", access: "auto" }, { system: "Be terse.", responseSchema: SCHEMA }));
    expect(prompt).toContain("<instructions>\nBe terse.");
    expect(prompt).toContain("JSON Schema");
  });
});

describe("antigravity", () => {
  it("uses --json-schema and puts the system prompt into the prompt", () => {
    const args = agyArgs(input({ provider: "antigravity", access: "accept-edits" }, { system: "Be terse.", responseSchema: SCHEMA }), []);
    expect(args[0]).toContain("<instructions>");
    expect(args[0]).not.toContain("JSON Schema");
    expect(args).toContain("--json-schema");
  });

  it("reads structured_output from the result", () => {
    const m = createMapper();
    const ev = m.map({ event: "result", result: { status: "SUCCESS", response: "ok", structured_output: { word: "ok" } } });
    expect(ev).toContainEqual({ type: "structured", data: { word: "ok" } });
  });
});

describe("api providers", () => {
  afterEach(() => vi.unstubAllGlobals());

  const capture = () => {
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
      }),
    );
    return bodies;
  };

  const drain = async (p: Provider, i: RunInput) => {
    for await (const _ of p.run(i)) {
      /* drain */
    }
  };

  it("anthropic: system, images, output_config and max_tokens", async () => {
    const bodies = capture();
    const p = createApiProviders({ anthropic: "k" })["anthropic-api"];
    await drain(p, input({ provider: "anthropic-api" }, { system: "S", attachments: [IMAGE], responseSchema: SCHEMA, maxOutputTokens: 100 }));
    const b = bodies[0];
    expect(b.system).toBe("S");
    expect(b.max_tokens).toBe(100);
    expect(b.output_config).toEqual({ format: { type: "json_schema", schema: SCHEMA.schema } });
    expect(b.messages[0].content[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
  });

  it("openai: system message, image parts, response_format and max tokens", async () => {
    const bodies = capture();
    const p = createApiProviders({ openai: "k" })["openai-api"];
    await drain(p, input({ provider: "openai-api" }, { system: "S", attachments: [IMAGE], responseSchema: SCHEMA, maxOutputTokens: 100 }));
    const b = bodies[0];
    expect(b.messages[0]).toEqual({ role: "system", content: "S" });
    expect(b.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${IMAGE.data}` } });
    expect(b.response_format.json_schema).toMatchObject({ name: "response", schema: SCHEMA.schema });
    expect(b.max_completion_tokens).toBe(100);
  });
});

describe("funnel and server", () => {
  let seen: RunInput | undefined;
  const fake: Provider = {
    id: "claude",
    displayName: "Fake",
    binary: "fake",
    capabilities: { access: ["none", "full"], effort: false, contextWindow: false, fast: false, resume: false, approvals: false, images: false, system: "native", schema: "native" },
    detect: async () => ({ installed: true, testedRange: { min: "0" } }),
    authStatus: async () => ({ loggedIn: true }),
    login: () => {
      throw new Error("no");
    },
    logout: async () => {},
    update: async () => ({ changed: false, output: "" }),
    models: async () => [{ id: "m", name: "M", provider: "claude", efforts: [], contextWindows: [], fast: false, source: "manifest" }],
    async *run(i) {
      seen = i;
      yield { type: "done", text: '{"word":"ok"}', finishReason: "stop" };
    },
  };
  const funnel = createFunnel({ providers: { claude: fake } });
  const cwd = mkdtempSync(join(tmpdir(), "cf-"));

  it("refuses images for a provider without image input", async () => {
    await expect(funnel.run(input({ cwd }, { attachments: [IMAGE] }))).rejects.toMatchObject({ code: "unsupported" });
  });

  it("returns structured output from run()", async () => {
    const r = await funnel.run(input({ cwd }, { responseSchema: SCHEMA }));
    expect(r.structured).toEqual({ word: "ok" });
  });

  it("maps OpenAI system messages, response_format and max_tokens", async () => {
    const handler = createHandler(funnel, { fsRoots: [tmpdir()], openai: { cwd, access: "none" } });
    await handler(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "claude/m",
          max_tokens: 50,
          response_format: { type: "json_schema", json_schema: { name: "w", schema: SCHEMA.schema } },
          messages: [
            { role: "system", content: "Be terse." },
            { role: "user", content: "hi" },
          ],
        }),
      }),
    );
    expect(seen).toMatchObject({ system: "Be terse.", prompt: "hi", maxOutputTokens: 50, responseSchema: { name: "w" } });
  });
});
