import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The tool every live MCP test uses: `add_note(text)`, which records what the model passed. */
const TOOL = { name: "add_note", description: "Saves a note for the user. Call it with the text of the note.", inputSchema: { type: "object", properties: { text: { type: "string", description: "The note." } }, required: ["text"] } };

const result = (id: unknown, r: unknown) => ({ jsonrpc: "2.0", id, result: r });

/** One JSON-RPC message answered, or undefined for a notification. `onCall` gets the text of each `add_note`. */
export function answer(msg: any, onCall: (text: string) => void): unknown {
  if (msg.method === "initialize") return result(msg.id, { protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1" } });
  if (msg.method === "tools/list") return result(msg.id, { tools: [TOOL] });
  if (msg.method === "tools/call") {
    onCall(String(msg.params?.arguments?.text ?? ""));
    return result(msg.id, { content: [{ type: "text", text: "Note saved." }] });
  }
  if (msg.id !== undefined && msg.method === "ping") return result(msg.id, {});
  // agy 1.5 opens with `server/discover`. A server that does not know it must say so, as the MCP SDKs do, or agy gives up.
  if (msg.id !== undefined) return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
  return undefined;
}

/** An HTTP MCP server on a free port. `calls` lists the notes, `seen` the method and the Authorization header of each request. */
export async function startNoteServer() {
  const calls: string[] = [];
  const seen: { method: string; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = req.method === "POST" && body ? JSON.parse(body) : {};
      seen.push({ method: `${req.method} ${msg.method ?? ""}`.trim(), auth: req.headers.authorization });
      if (req.method !== "POST") return void res.writeHead(405).end();
      const reply = answer(msg, (t) => calls.push(t));
      if (!reply) return void res.writeHead(202).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, calls, seen, close: () => server.close() };
}

/** A stdio MCP server as a script. It appends each note to `notes.log` in its folder, so the test reads them there. */
export function noteScript(): { command: string; args: string[]; calls(): string[] } {
  const dir = mkdtempSync(join(tmpdir(), "cf-note-mcp-"));
  const log = join(dir, "notes.log");
  const script = join(dir, "server.mjs");
  writeFileSync(log, "");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const TOOL = ${JSON.stringify(TOOL)};
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") send(m.id, { protocolVersion: m.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1" } });
  else if (m.method === "tools/list") send(m.id, { tools: [TOOL] });
  else if (m.method === "tools/call") { appendFileSync(${JSON.stringify(log)}, String(m.params?.arguments?.text ?? "") + "\\n"); send(m.id, { content: [{ type: "text", text: "Note saved." }] }); }
  else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
});
`,
  );
  return { command: process.execPath, args: [script], calls: () => (readFileSyncSafe(log).split("\n").filter(Boolean)) };
}

import { readFileSync } from "node:fs";
const readFileSyncSafe = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
