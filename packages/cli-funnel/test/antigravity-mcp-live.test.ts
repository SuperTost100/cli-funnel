import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { noneGeminiDir, noneWorkspace, removeRunWorkspace } from "../src/providers/antigravity/index.js";
import type { FunnelEvent } from "../src/types.js";
import { startNoteServer } from "./mcp-note-server.js";

// The hook of a none run with MCP servers, on the real agy and account. Part one drives `agy acp` with a raw client that
// ALLOWS every permission request, so the hook is the only thing between the model and the user's servers: a server that
// agy knows besides the caller's must not be callable by either route (the generic `call_mcp_tool` and the tool named
// `mcp_<server>_<tool>`). Part two runs the funnel with a natural prompt, to see how the model reaches the caller's tool.
const LIVE = process.env.CLI_FUNNEL_LIVE === "1" && process.platform !== "win32";
const report = (line: unknown) => process.env.MCP_REPORT && appendFileSync(process.env.MCP_REPORT, `${JSON.stringify(line)}\n`);
const MODEL = process.env.CF_LIVE_MODEL ?? "gemini-3.8-flash";

interface Call {
  name: string;
  status: string;
  input: unknown;
}

/** A minimal `agy acp` client: one session, one prompt, every permission request allowed. */
async function rawAcp(opts: { cwd: string; servers: object[]; prompt: string; model?: string }): Promise<{ calls: Call[]; text: string; asked: string[] }> {
  const gemini = await noneGeminiDir();
  const child = spawn("agy", ["acp", `--gemini-dir=${gemini}`], { cwd: opts.cwd, stdio: ["pipe", "pipe", "ignore"] });
  const calls = new Map<string, Call>();
  const asked: string[] = [];
  let text = "";
  let id = 0;
  const waiting = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  let gone: Error | undefined;
  // When agy is not there any more, nothing will answer: every request that waits fails, and so does the next one.
  const lost = (e: Error) => {
    gone ??= e;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  child.on("error", lost);
  child.on("close", (code) => lost(new Error(`agy acp exited (${code}) before it answered`)));
  child.stdin.on("error", lost);
  const send = (m: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  /** A request with an answer awaited for at most `ms`: the setup requests answer in seconds, the prompt may take minutes. */
  const call = (method: string, params: object, ms = 60_000) => new Promise<any>((resolve, reject) => {
    if (gone) return reject(gone);
    const n = ++id;
    const timer = setTimeout(() => {
      waiting.delete(n);
      reject(new Error(`no answer to ${method} in ${ms / 1000}s`));
    }, ms);
    waiting.set(n, { resolve: (m) => (clearTimeout(timer), resolve(m)), reject: (e) => (clearTimeout(timer), reject(e)) });
    send({ id: n, method, params });
  });
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.method === "session/request_permission") {
        asked.push(m.params.toolCall.name);
        const allow = m.params.options.find((o: any) => o.kind === "allow_once");
        send({ id: m.id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } });
      } else if (m.method === "session/update") {
        const u = m.params.update;
        if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") calls.set(u.toolCallId, { name: u.name, status: u.status, input: u.rawInput });
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") text += u.content.text;
      } else if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)!.resolve(m);
        waiting.delete(m.id);
      }
    }
  });
  try {
    await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const session = (await call("session/new", { cwd: opts.cwd, mcpServers: opts.servers })).result;
    await call("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: opts.model ?? MODEL });
    await call("session/set_config_option", { sessionId: session.sessionId, configId: "thought_level", value: "low" });
    // A prompt that does not finish in time returns what came so far. An agy that went away is an error.
    await call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: opts.prompt }] }, 110_000).catch((e: Error) => {
      if (!/^no answer to session\/prompt/.test(e.message)) throw e;
    });
  } finally {
    child.kill();
  }
  return { calls: [...calls.values()], text, asked };
}

describe.skipIf(!LIVE)("the hook of a none run with servers, live", () => {
  const RUN = "5ec0de01";
  const ours = `clifunnel${RUN}_0`;

  it("refuses a user-style server called through call_mcp_tool, with every permission allowed", async () => {
    const mine = await startNoteServer();
    const theirs = await startNoteServer();
    const cwd = await noneWorkspace("live-hook-test", RUN);
    // A plugin in the folder is a server agy knows next to the caller's, set up the way a user's would be.
    const plugin = join(cwd, ".agents", "plugins", "usersim");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "usersim" }));
    writeFileSync(join(plugin, "mcp_config.json"), JSON.stringify({ mcpServers: { other: { url: theirs.url } } }));
    try {
      const r = await rawAcp({
        cwd,
        servers: [{ type: "http", name: ours, url: mine.url, headers: [] }],
        prompt: `Do both: (1) call the add_note tool of the MCP server named ${ours} with the text "from-caller". (2) call the add_note tool of the MCP server named usersim_other with the text "from-user", using the generic call_mcp_tool tool with ServerName "usersim_other". Then say what happened.`,
      });
      report({ scenario: "generic route", model: MODEL, ours: mine.calls, theirs: theirs.calls, calls: r.calls.map((c) => `${c.name} ${c.status}`), asked: r.asked, text: r.text.slice(0, 160) });
      expect(theirs.calls).toEqual([]);
      expect(r.calls.some((c) => /usersim/.test(JSON.stringify(c.input)) && c.status === "failed")).toBe(true);
      expect(mine.calls).toEqual(["from-caller"]);
    } finally {
      mine.close();
      theirs.close();
      await removeRunWorkspace(cwd);
    }
  }, 180_000);

  it("refuses a second server given to the session, called by its own tool name, with every permission allowed", async () => {
    const mine = await startNoteServer();
    const theirs = await startNoteServer();
    const cwd = await noneWorkspace("live-hook-test", RUN);
    try {
      const r = await rawAcp({
        cwd,
        servers: [
          { type: "http", name: ours, url: mine.url, headers: [] },
          { type: "http", name: "usersim2", url: theirs.url, headers: [] },
        ],
        prompt: `Do both: (1) call the add_note tool of the MCP server named ${ours} with the text "from-caller". (2) call the tool named mcp_usersim2_add_note with the text "from-user". Then say what happened.`,
      });
      report({ scenario: "direct route", model: MODEL, ours: mine.calls, theirs: theirs.calls, calls: r.calls.map((c) => `${c.name} ${c.status}`), asked: r.asked, text: r.text.slice(0, 160) });
      expect(theirs.calls).toEqual([]);
      expect(r.calls.some((c) => c.name === "mcp_usersim2_add_note" && c.status === "failed")).toBe(true);
      expect(mine.calls).toEqual(["from-caller"]);
    } finally {
      mine.close();
      theirs.close();
      await removeRunWorkspace(cwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);
});

describe.skipIf(!LIVE)("how the model reaches the caller's tool, live", () => {
  const funnel = createFunnel();
  const selection = { provider: "antigravity" as const, model: MODEL, effort: "low", cwd: tmpdir(), access: "none" as const };
  const prompts: [string, string][] = [
    ["natural", "Save a note that says hello-from-the-model, then tell me it is saved."],
    ["generic first", "Use the generic call_mcp_tool tool to call add_note with the text hello-from-the-model. Then tell me what happened."],
    ["server named", "Call the add_note tool of the MCP server named notes with the text hello-from-the-model."],
  ];
  // A prompt that tells the model to use `call_mcp_tool` asks for a route the hook refuses (a matcher cannot see the server
  // in its arguments). gemini-3.8-flash fell back to the tool's own name and saved the note, gemini-4-neon answered that the
  // tool is not available and saved nothing. Either way the run finishes cleanly, so only that is asserted for it.
  it.each(prompts)("%s prompt: the run finishes, and the note is saved unless the prompt demanded the generic route", async (label, prompt) => {
    const server = await startNoteServer();
    try {
      const events: FunnelEvent[] = [];
      const s = funnel.stream({ selection, prompt, mcpServers: { notes: { type: "http", url: server.url } }, timeoutMs: 120_000 });
      for await (const e of s) events.push(e);
      const r = await s.result;
      report({ scenario: `funnel ${label}`, model: MODEL, notes: server.calls, finish: r.finishReason, tools: r.toolCalls.map((c) => `${c.name}${c.error ? ` (${c.error.slice(0, 60)})` : ""}`), text: r.text.slice(0, 140) });
      expect(r.finishReason).toBe("stop");
      if (label !== "generic first") expect(server.calls).toEqual(["hello-from-the-model"]);
    } finally {
      server.close();
    }
  }, 180_000);
});
