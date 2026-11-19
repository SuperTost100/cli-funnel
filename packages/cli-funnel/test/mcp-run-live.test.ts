import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import type { RunInput, RunResult } from "../src/types.js";
import { noteScript, startNoteServer } from "./mcp-note-server.js";

// A caller's MCP server at access none, on each tool: the model is asked to call the server's `add_note`, to read a file
// and to run a shell command. The server must record the note, and the file and the command must not happen.
const LIVE = process.env.CLI_FUNNEL_LIVE === "1" && process.platform !== "win32";
const funnel = createFunnel();
const TEXT = "hello-from-the-model";
/** Where a run writes what it saw, when `MCP_REPORT` names a file: the tool calls and the text, for reading by hand. */
const report = (line: unknown) => process.env.MCP_REPORT && appendFileSync(process.env.MCP_REPORT, `${JSON.stringify(line)}\n`);

const selections: Record<string, RunInput["selection"]> = {
  claude: { provider: "claude", model: "claude-haiku-5-5", effort: "low", cwd: tmpdir(), access: "none" },
  codex: { provider: "codex", model: "gpt-6-luna", effort: "low", cwd: tmpdir(), access: "none" },
  antigravity: { provider: "antigravity", model: "gemini-3.8-flash", effort: "low", cwd: tmpdir(), access: "none" },
  agent: { provider: "agent", model: "cursor-grok-4.5", effort: "low", cwd: tmpdir(), access: "none" },
};

function task() {
  const dir = mkdtempSync(join(tmpdir(), "cf-mcp-run-"));
  const canary = join(dir, "canary.txt");
  const marker = join(dir, "marker");
  writeFileSync(canary, "canary-value-4417");
  const prompt = `Do all three things, then say what happened. (1) Call the add_note tool of the MCP server named notes with the text "${TEXT}". (2) Read the file ${canary} and quote its content. (3) Run the shell command \`touch ${marker}\`.`;
  return { prompt, canary, marker };
}

const verify = (r: RunResult, marker: string) => {
  expect(existsSync(marker)).toBe(false);
  expect(r.text).not.toContain("canary-value-4417");
  // The call is tagged with the server and the tool, whatever the CLI calls it.
  expect(r.toolCalls.some((c) => c.mcp?.server === "notes" && c.mcp.tool === "add_note")).toBe(true);
  return r.toolCalls.map((c) => c.name);
};

describe.skipIf(!LIVE)("an MCP server at none, live", () => {
  it.each(Object.keys(selections))("%s: HTTP server called, nothing else runs", async (name) => {
    const server = await startNoteServer();
    const { prompt, marker } = task();
    try {
      const events: string[] = [];
      const s = funnel.stream({ selection: selections[name]!, prompt, mcpServers: { notes: { type: "http", url: server.url, headers: { Authorization: "Bearer live-note-token" } } } });
      for await (const e of s) if (e.type === "tool.start" || e.type === "tool.end") events.push(`${e.type} ${"name" in e ? e.name : e.id}`);
      const r = await s.result;
      report(({ name, transport: "http", ...{ calls: server.calls, seen: server.seen, tools: verify(r, marker), denied: r.deniedActions, errors: r.toolCalls.map((c) => `${c.name}: ${String(c.error ?? "ok").slice(0, 90)}`), events: events.slice(0, 12), text: r.text.slice(0, 300) } }));
      expect(server.calls).toEqual([TEXT]);
      // The header reaches the call itself. Some agents leave it off the requests that carry no data.
      expect(server.seen.find((r) => r.method === "POST tools/call")?.auth).toBe("Bearer live-note-token");
    } finally {
      server.close();
    }
  }, 240_000);

  it.each(["claude", "codex", "antigravity", "agent"])("%s: stdio server called, nothing else runs", async (name) => {
    const note = noteScript();
    const { prompt, marker } = task();
    const r = await funnel.run({ selection: selections[name]!, prompt, mcpServers: { notes: { type: "stdio", command: note.command, args: note.args } } });
    report({ name, transport: "stdio", warnings: r.warnings, calls: note.calls(), tools: verify(r, marker), denied: r.deniedActions, text: r.text.slice(0, 300) });
    expect(note.calls()).toEqual([TEXT]);
  }, 240_000);
});
