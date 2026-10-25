import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentProvider } from "../src/providers/agent/index.js";
import { collect } from "./helpers.js";
import type { RunInput } from "../src/types.js";

const sel = (o: Partial<RunInput["selection"]>): RunInput["selection"] => ({ provider: "agent", model: "composer-2.5", cwd: "/tmp", access: "auto", ...o });

describe.skipIf(process.env.CLI_FUNNEL_LIVE !== "1")("agent live MCP servers", () => {
  const word = `kiwi${Math.floor(Math.random() * 1e6)}`;
  const prompt = "Call the get_word tool of the MCP server named app (an MCP tool, not the shell) and tell me the word. Be brief.";

  async function startServer() {
    const seen: { rpc?: string; auth?: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = body ? JSON.parse(body) : {};
        seen.push({ rpc: msg.method, auth: req.headers.authorization });
        if (req.method !== "POST") return void res.writeHead(405).end();
        const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        if (msg.method === "initialize") return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } });
        if (msg.method === "tools/list") return reply({ tools: [{ name: "get_word", description: "Returns the secret word.", inputSchema: { type: "object", properties: {} } }] });
        if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: `the secret word is ${word}` }] });
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/mcp`, seen, close: () => server.close() };
  }

  it("calls an HTTP server with its header at auto, without touching the project", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cf-agent-mcp-live-"));
    const server = await startServer();
    try {
      const input: RunInput = { selection: sel({ cwd, access: "auto" }), prompt, mcpServers: { app: { type: "http", url: server.url, headers: { Authorization: "Bearer live-test-token" } } } };
      const res = await collect(agentProvider.run(input), input);
      expect(res.text).toContain(word);
      expect(server.seen.find((s) => s.rpc === "tools/call")?.auth).toBe("Bearer live-test-token");
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      server.close();
    }
  }, 180_000);

  it("starts a stdio server at full", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-agent-mcp-stdio-live-"));
    const script = join(dir, "server.mjs");
    writeFileSync(
      script,
      `import { createInterface } from "node:readline";
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") send(m.id, { protocolVersion: m.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "s", version: "1" } });
  else if (m.method === "tools/list") send(m.id, { tools: [{ name: "get_word", description: "Returns the secret word.", inputSchema: { type: "object", properties: {} } }] });
  else if (m.method === "tools/call") send(m.id, { content: [{ type: "text", text: "the secret word is " + process.env.WORD }] });
});
`,
    );
    const cwd = mkdtempSync(join(tmpdir(), "cf-agent-mcp-stdio-cwd-"));
    const input: RunInput = { selection: sel({ cwd, access: "full" }), prompt, mcpServers: { app: { type: "stdio", command: process.execPath, args: [script], env: { WORD: word } } } };
    const res = await collect(agentProvider.run(input), input);
    expect(res.text).toContain(word);
  }, 180_000);
});
