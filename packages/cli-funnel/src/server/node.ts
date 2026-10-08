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
    let res: Response;
    try {
      const url = `http://${nodeReq.headers.host ?? host}${nodeReq.url ?? "/"}`;
      const hasBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD";
      // Throws on methods fetch does not allow, such as TRACE and CONNECT, and on a malformed Host header.
      const req = new Request(url, {
        method: nodeReq.method,
        headers: nodeReq.headers as Record<string, string>,
        body: hasBody ? (Readable.toWeb(nodeReq) as ReadableStream) : undefined,
        duplex: "half",
        signal: ac.signal,
      } as RequestInit);
      res = await handler(req);
    } catch (err) {
      res = Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
    nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
    if (!res.body) return nodeRes.end();
    const reader = res.body.getReader();
    // A client that hangs up cancels the body, which ends the run behind it.
    nodeRes.on("close", () => void reader.cancel().catch(() => {}));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    } catch {
      /* the body was cancelled or failed; the response ends below */
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
