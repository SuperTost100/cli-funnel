import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

/** Serves a fetch-style handler with node:http. Binds to localhost unless told otherwise. */
export function serveNode(
  handler: (req: Request) => Promise<Response>,
  opts: { port?: number; host?: string } = {},
): Promise<{ server: Server; url: string }> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(async (nodeReq, nodeRes) => {
    const ac = new AbortController();
    nodeRes.on("close", () => ac.abort());
    const url = `http://${nodeReq.headers.host ?? host}${nodeReq.url ?? "/"}`;
    const hasBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD";
    const req = new Request(url, {
      method: nodeReq.method,
      headers: nodeReq.headers as Record<string, string>,
      body: hasBody ? (Readable.toWeb(nodeReq) as ReadableStream) : undefined,
      duplex: "half",
      signal: ac.signal,
    } as RequestInit);
    const res = await handler(req);
    nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
    if (!res.body) return nodeRes.end();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    } finally {
      nodeRes.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 4747, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({ server, url: `http://${host}:${port}` });
    });
  });
}
