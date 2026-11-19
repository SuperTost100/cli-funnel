import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { noneWorkspace } from "../src/providers/antigravity/index.js";
import type { FunnelEvent } from "../src/types.js";
import { startNoteServer } from "./mcp-note-server.js";

// A second server, configured the way a user's agy config would be, next to the one the caller attaches. In a none run
// the caller's server must work and the other must not be callable, through `call_mcp_tool` with the server's name. The other route, the tool named mcp_<server>_<tool>, is only there for a
// server given to the session, so it was checked once by hand with a raw `agy acp` client that allowed every permission
// request, to see the hook alone (see docs/providers/antigravity.md). The "user" server is a plugin folder, which agy loads
// the same way as a server of its own config, put in a folder this test owns so nobody's real config changes.
const LIVE = process.env.CLI_FUNNEL_LIVE === "1" && process.platform !== "win32";
const report = (line: unknown) => process.env.MCP_REPORT && appendFileSync(process.env.MCP_REPORT, `${JSON.stringify(line)}\n`);
const funnel = createFunnel();
const base = { provider: "antigravity" as const, model: "gemini-3.8-flash", effort: "low" };

function plugin(dir: string, url: string): void {
  const folder = join(dir, ".agents", "plugins", "usersim");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "plugin.json"), JSON.stringify({ name: "usersim" }));
  writeFileSync(join(folder, "mcp_config.json"), JSON.stringify({ mcpServers: { other: { url } } }));
}

describe.skipIf(!LIVE)("a user's server next to the caller's, at none, live", () => {
  it("can be called at full, so the runs below test something", async () => {
    const theirs = await startNoteServer();
    const cwd = mkdtempSync(join(tmpdir(), "cf-agy-usersim-"));
    plugin(cwd, theirs.url);
    try {
      const events: FunnelEvent[] = [];
      for await (const e of funnel.stream({ selection: { ...base, cwd, access: "full" }, prompt: 'Call the add_note tool of the MCP server named usersim_other with the text "from-full", using the generic call_mcp_tool tool with ServerName "usersim_other". Then say what happened.', timeoutMs: 120_000 })) events.push(e);
      report({ run: "full", calls: theirs.calls, seen: theirs.seen.map((s) => s.method), tools: events.filter((e) => e.type === "tool.start").map((e: any) => `${e.name} ${JSON.stringify(e.input).slice(0, 100)}`) });
      expect(theirs.calls).toEqual(["from-full"]);
    } finally {
      theirs.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);

  it("none: the caller's server is called and the user's is not, through call_mcp_tool", async () => {
    const _form = "call_mcp_tool";
    const prompt = 'Do both: (1) call the add_note tool of the MCP server named clifunnel0 with the text "from-caller". (2) call the add_note tool of the MCP server named usersim_other with the text "from-user", using the generic call_mcp_tool tool with ServerName "usersim_other". Then say what happened.';
    const ours = await startNoteServer();
    const theirs = await startNoteServer();
    // The folder of a none run with one server is the one cli-funnel makes for it. The plugin goes next to its hook.
    const dir = await noneWorkspace("live-test-usersim", 1);
    plugin(dir, theirs.url);
    try {
      const events: FunnelEvent[] = [];
      const s = funnel.stream({
        selection: { ...base, cwd: tmpdir(), access: "none" },
        workspaceName: "live-test-usersim",
        prompt,
        mcpServers: { notes: { type: "http", url: ours.url } },
        timeoutMs: 120_000,
      });
      for await (const e of s) events.push(e);
      const r = await s.result;
      const starts = events.filter((e): e is Extract<FunnelEvent, { type: "tool.start" }> => e.type === "tool.start");
      report({ run: _form, ours: ours.calls, theirs: theirs.calls, tools: r.toolCalls.map((c) => `${c.name} ${JSON.stringify(c.input).slice(0, 90)} ${c.error?.slice(0, 60) ?? "ok"}`), tagged: starts.filter((e) => e.mcp).map((e) => e.mcp), text: r.text.slice(0, 200) });
      expect(ours.calls).toEqual(["from-caller"]);
      expect(theirs.calls).toEqual([]);
      // The model did try the other server, and the attempt ended in an error.
      const tried = r.toolCalls.filter((c) => /usersim/.test(`${c.name} ${JSON.stringify(c.input)}`));
      expect(tried.length).toBeGreaterThan(0);
      expect(tried.every((c) => c.error !== undefined)).toBe(true);
      // The caller's own call is tagged with the caller's name, not the one agy knows it by.
      expect(r.toolCalls.some((c) => c.mcp?.server === "notes" && c.mcp.tool === "add_note")).toBe(true);
    } finally {
      ours.close();
      theirs.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
