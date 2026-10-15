import { connect, type Socket } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { serveNode } from "../src/server/node.js";

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

const start = async (handler: (req: Request) => Promise<Response>, opts: { port?: number; host?: string } = {}) => {
  const r = await serveNode(handler, { port: 0, ...opts });
  servers.push(r.server);
  return r;
};

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

describe("serveNode", () => {
  it("rejects instead of crashing when the port is taken", async () => {
    const first = await start(async () => new Response("ok"));
    const port = Number(new URL(first.url).port);
    await expect(serveNode(async () => new Response("ok"), { port })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("writes an IPv6 host with brackets in the URL", async () => {
    const plain = await start(async () => new Response("ok"), { host: "::1" });
    expect(plain.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    const bracketed = await start(async () => new Response("ok"), { host: "[::1]" });
    expect(bracketed.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    expect(await (await fetch(plain.url)).text()).toBe("ok");
  });

  it("waits for drain when the client reads slowly", async () => {
    const chunk = new Uint8Array(256 * 1024);
    const total = 200;
    let pulled = 0;
    let cancelled = false;
    const { url } = await start(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (pulled >= total) return controller.close();
              pulled++;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const { port } = new URL(url);
    const socket = connect(Number(port), "127.0.0.1");
    sockets.push(socket);
    let received = 0;
    socket.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
    // Do not read: the socket buffers fill up and the server has to stop pulling.
    socket.pause();
    await new Promise((r) => setTimeout(r, 400));
    expect(pulled).toBeLessThan(100);
    expect(pulled).toBeGreaterThan(0);

    socket.on("data", (d) => (received += d.length));
    socket.resume();
    expect(await until(() => received >= total * chunk.length)).toBe(true);
    expect(pulled).toBe(total);
    expect(cancelled).toBe(false);
  });

  it("stops waiting for drain when the client hangs up", async () => {
    const chunk = new Uint8Array(256 * 1024);
    let cancelled = false;
    let pulled = 0;
    const { url } = await start(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              // Long enough to fill every socket buffer, short enough to end a run that ignores backpressure.
              if (pulled++ >= 400) return controller.close();
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const socket = connect(Number(new URL(url).port), "127.0.0.1");
    sockets.push(socket);
    socket.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
    socket.pause();
    await new Promise((r) => setTimeout(r, 300));
    socket.destroy();
    expect(await until(() => cancelled)).toBe(true);
  });
});
