import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.env.MARKER_FILE ?? "/tmp/cf-marker.log", `started ${process.pid} ${process.argv[2] ?? ""}\n`);
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") send(m.id, { protocolVersion: m.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "marker", version: "1" } });
  else if (m.method === "tools/list") send(m.id, { tools: [] });
  else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } }) + "\n");
});
