import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/bin/run-input.js";
import { parseServeConfig, readServeConfig, resolveServe, type ServeConfig } from "../src/bin/serve-config.js";
import { createFunnel } from "../src/funnel.js";
import { corsOrigin, createHandler } from "../src/server/handler.js";

const where = { cwd: "/work/app", home: "/home/me" };
const parse = (raw: unknown) => parseServeConfig(raw, "/etc/cf/serve.json");

describe("parseServeConfig", () => {
  it("accepts every key and resolves relative folders against the file", () => {
    const config = parse({
      port: 9000,
      host: "100.64.0.7",
      cwd: "../project",
      access: "none",
      token: "t",
      allowedHosts: ["devbox.example.ts.net"],
      tailscale: false,
      fsRoots: ["/srv/code", "repos"],
      approvalTimeoutSec: 60,
      cors: "https://app.example.com",
      logJsonl: "logs/runs.jsonl",
      logContent: false,
      basePath: "/funnel",
      sessions: { keepAlive: true, idleMs: 60_000, max: 4 },
      maxConcurrentRuns: { total: 4, perProvider: { claude: 2, codex: 1 } },
      maxQueuedRuns: 0,
      queueTimeoutMs: 30_000,
      openai: { cwd: "scratch", access: "none" },
      openaiCompatible: [{ id: "lm", name: "LM", baseUrl: "http://127.0.0.1:1234/v1" }],
    });
    expect(config.fsRoots).toEqual(["/srv/code", "/etc/cf/repos"]);
    expect(config.cwd).toBe("/etc/project");
    expect(config.logJsonl).toBe("/etc/cf/logs/runs.jsonl");
    expect(config.openai).toEqual({ cwd: "/etc/cf/scratch", access: "none" });
  });

  it("rejects unknown keys so a typo cannot widen access", () => {
    expect(() => parse({ fsRoot: ["/"] })).toThrow(/unknown key "fsRoot"/);
  });

  it("names the key that has the wrong type", () => {
    expect(() => parse([])).toThrow(/JSON object/);
    expect(() => parse({ port: "80" })).toThrow(/"port" must be a port number/);
    expect(() => parse({ access: "root" })).toThrow(/"access" must be one of/);
    expect(() => parse({ fsRoots: "/srv" })).toThrow(/"fsRoots" must be a list/);
    expect(() => parse({ approvalTimeoutSec: 0 })).toThrow(/"approvalTimeoutSec"/);
    expect(() => parse({ token: "" })).toThrow(/"token"/);
    expect(() => parse({ cors: true })).toThrow(/"cors"/);
    expect(() => parse({ logJsonl: "" })).toThrow(/"logJsonl"/);
    expect(() => parse({ logContent: "yes" })).toThrow(/"logContent"/);
    expect(() => parse({})).not.toThrow();
  });

  it("checks the session and queue keys", () => {
    expect(() => parse({ sessions: true })).toThrow(/"sessions" must be an object/);
    expect(() => parse({ sessions: { keepAlive: "yes" } })).toThrow(/sessions\.keepAlive/);
    expect(() => parse({ sessions: { idleMs: 0 } })).toThrow(/sessions\.idleMs/);
    expect(() => parse({ sessions: { max: 1.5 } })).toThrow(/sessions\.max/);
    expect(() => parse({ sessions: { keepalive: true } })).toThrow(/unknown key "sessions\.keepalive"/);
    expect(() => parse({ maxConcurrentRuns: 0 })).toThrow(/"maxConcurrentRuns"/);
    expect(() => parse({ maxConcurrentRuns: { totl: 2 } })).toThrow(/"maxConcurrentRuns"/);
    expect(() => parse({ maxConcurrentRuns: { perProvider: { claude: 0 } } })).toThrow(/"maxConcurrentRuns"/);
    expect(() => parse({ maxConcurrentRuns: 3 })).not.toThrow();
    expect(() => parse({ maxConcurrentRuns: { perProvider: 1 } })).not.toThrow();
    expect(() => parse({ maxQueuedRuns: -1 })).toThrow(/"maxQueuedRuns"/);
    expect(() => parse({ queueTimeoutMs: 0 })).toThrow(/"queueTimeoutMs"/);
  });

  it("reads a file and reports a missing or broken one as a usage error", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-serve-"));
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ fsRoots: ["code"] }));
    writeFileSync(join(dir, "bad.json"), "{");
    expect(readServeConfig(join(dir, "ok.json")).fsRoots).toEqual([join(dir, "code")]);
    expect(() => readServeConfig(join(dir, "bad.json"))).toThrow(UsageError);
    expect(() => readServeConfig(join(dir, "none.json"))).toThrow(/ENOENT/);
  });
});

describe("resolveServe", () => {
  it("keeps today's defaults with no flags, file or environment", () => {
    const s = resolveServe({}, {}, {}, where);
    expect(s).toMatchObject({ host: "127.0.0.1", port: 4747, token: undefined });
    expect(s.handler.fsRoots).toEqual(["/home/me", "/work/app"]);
    expect(s.handler.openai).toEqual({ cwd: "/work/app", access: "accept-edits" });
    expect(s.handler.cors).toBeUndefined();
    expect(s.handler.approvalTimeoutSec).toBeUndefined();
  });

  it("lets a flag beat the file and the file beat the environment", () => {
    const config: ServeConfig = { port: 9000, token: "from-file", approvalTimeoutSec: 60, allowedHosts: ["file.example"], cors: "https://file.example" };
    const env = { CLI_FUNNEL_TOKEN: "from-env", CLI_FUNNEL_ALLOWED_HOSTS: "env.example" };
    const fromFile = resolveServe({}, config, env, where);
    expect(fromFile).toMatchObject({ port: 9000, token: "from-file" });
    expect(fromFile.handler).toMatchObject({ approvalTimeoutSec: 60, allowedHosts: ["file.example"], cors: "https://file.example" });
    const fromFlags = resolveServe({ port: "9100", token: "flag", "approval-timeout": "5", cors: "https://flag.example" }, config, env, where);
    expect(fromFlags).toMatchObject({ port: 9100, token: "flag" });
    expect(fromFlags.handler).toMatchObject({ approvalTimeoutSec: 5, cors: "https://flag.example" });
    const fromEnv = resolveServe({}, {}, env, where);
    expect(fromEnv.token).toBe("from-env");
    expect(fromEnv.handler.allowedHosts).toEqual(["env.example"]);
  });

  it("uses --fs-root alone when given, and runs the OpenAI endpoints in the first root", () => {
    const s = resolveServe({ "fs-root": ["/srv/a", "b"] }, { fsRoots: ["/from/file"] }, {}, where);
    expect(s.handler.fsRoots).toEqual(["/srv/a", resolve(where.cwd, "b")]);
    expect(s.handler.openai?.cwd).toBe("/srv/a");
    expect(resolveServe({ "fs-root": ["/srv/a"], cwd: "/srv/a/x" }, {}, {}, where).handler.openai?.cwd).toBe("/srv/a/x");
  });

  it("stops runs after 30 minutes unless --timeout or maxRunMs says otherwise", () => {
    expect(resolveServe({}, {}, {}, where).handler.maxRunMs).toBe(1_800_000);
    expect(resolveServe({}, { maxRunMs: 60_000 }, {}, where).handler.maxRunMs).toBe(60_000);
    expect(resolveServe({ timeout: "90" }, { maxRunMs: 60_000 }, {}, where).handler.maxRunMs).toBe(90_000);
    expect(resolveServe({ timeout: "0" }, {}, {}, where).handler.maxRunMs).toBe(0);
    expect(() => resolveServe({ timeout: "soon" }, {}, {}, where)).toThrow(/--timeout/);
    expect(() => parseServeConfig({ maxRunMs: -1 }, "c.json")).toThrow(/"maxRunMs"/);
  });

  it("takes the access level from the flag, then openai.access, then access", () => {
    expect(resolveServe({}, { access: "none" }, {}, where).handler.openai?.access).toBe("none");
    expect(resolveServe({}, { access: "none", openai: { access: "full" } }, {}, where).handler.openai?.access).toBe("full");
    expect(resolveServe({ access: "supervised" }, { access: "none" }, {}, where).handler.openai?.access).toBe("supervised");
  });

  it("logs nothing unless a file is named, and keeps text out unless asked", () => {
    expect(resolveServe({}, {}, {}, where).log).toBeUndefined();
    expect(resolveServe({ "log-jsonl": "runs.jsonl" }, {}, {}, where).log).toEqual({ file: "runs.jsonl", content: false });
    expect(resolveServe({ "log-content": true }, { logJsonl: "/var/log/cf.jsonl" }, {}, where).log).toEqual({ file: "/var/log/cf.jsonl", content: true });
    expect(resolveServe({ "log-jsonl": "a" }, { logJsonl: "b", logContent: true }, {}, where).log).toEqual({ file: "a", content: true });
    expect(() => resolveServe({ "log-content": true }, {}, {}, where)).toThrow(/--log-jsonl/);
  });

  it("keeps live sessions and the queue off by default", () => {
    const s = resolveServe({}, {}, {}, where);
    expect(s.sessions).toBeUndefined();
    expect(s.handler.maxConcurrentRuns).toBeUndefined();
    expect(s.handler.maxQueuedRuns).toBeUndefined();
    expect(s.handler.queueTimeoutMs).toBeUndefined();
  });

  it("turns on live sessions from --keep-alive or the file, and lets flags win", () => {
    expect(resolveServe({ "keep-alive": true }, {}, {}, where).sessions).toEqual({ keepAlive: true, idleMs: undefined, max: undefined });
    expect(resolveServe({}, { sessions: { keepAlive: true, idleMs: 60_000, max: 4 } }, {}, where).sessions).toEqual({ keepAlive: true, idleMs: 60_000, max: 4 });
    const flagged = resolveServe({ "keep-alive": true, "session-idle": "30", "max-sessions": "2" }, { sessions: { keepAlive: true, idleMs: 60_000, max: 4 } }, {}, where);
    expect(flagged.sessions).toEqual({ keepAlive: true, idleMs: 30_000, max: 2 });
    expect(resolveServe({}, { sessions: { keepAlive: false } }, {}, where).sessions).toBeUndefined();
  });

  it("refuses session tuning without keep-alive, and bad session numbers", () => {
    expect(() => resolveServe({ "session-idle": "30" }, {}, {}, where)).toThrow(/--keep-alive/);
    expect(() => resolveServe({ "max-sessions": "2" }, {}, {}, where)).toThrow(/--keep-alive/);
    expect(() => resolveServe({}, { sessions: { max: 2 } }, {}, where)).toThrow(/--keep-alive/);
    const on = { "keep-alive": true };
    expect(() => resolveServe({ ...on, "session-idle": "0" }, {}, {}, where)).toThrow(/--session-idle/);
    expect(() => resolveServe({ ...on, "session-idle": "soon" }, {}, {}, where)).toThrow(/--session-idle/);
    expect(() => resolveServe({ ...on, "max-sessions": "0" }, {}, {}, where)).toThrow(/--max-sessions/);
    expect(() => resolveServe({ ...on, "max-sessions": "1.5" }, {}, {}, where)).toThrow(/--max-sessions/);
  });

  it("reads the queue limits from flags, then the file", () => {
    const config: ServeConfig = { maxConcurrentRuns: { total: 4, perProvider: { claude: 2 } }, maxQueuedRuns: 20, queueTimeoutMs: 120_000 };
    expect(resolveServe({}, config, {}, where).handler).toMatchObject(config);
    const flags = { "max-concurrent": "2", "max-queued": "0", "queue-timeout": "1.5" };
    expect(resolveServe(flags, config, {}, where).handler).toMatchObject({ maxConcurrentRuns: 2, maxQueuedRuns: 0, queueTimeoutMs: 1500 });
  });

  it("rejects bad queue numbers and a queue without a run limit", () => {
    const limit = { "max-concurrent": "2" };
    expect(() => resolveServe({ "max-concurrent": "0" }, {}, {}, where)).toThrow(/--max-concurrent/);
    expect(() => resolveServe({ "max-concurrent": "two" }, {}, {}, where)).toThrow(/--max-concurrent/);
    expect(() => resolveServe({ ...limit, "max-queued": "-1" }, {}, {}, where)).toThrow(/--max-queued/);
    expect(() => resolveServe({ ...limit, "queue-timeout": "0" }, {}, {}, where)).toThrow(/--queue-timeout/);
    expect(() => resolveServe({ "max-queued": "5" }, {}, {}, where)).toThrow(/--max-concurrent/);
    expect(() => resolveServe({ "queue-timeout": "5" }, {}, {}, where)).toThrow(/--max-concurrent/);
    expect(() => resolveServe({}, { maxQueuedRuns: 5 }, {}, where)).toThrow(/--max-concurrent/);
  });

  it("rejects bad numbers and levels", () => {
    expect(() => resolveServe({ "approval-timeout": "0" }, {}, {}, where)).toThrow(/--approval-timeout/);
    expect(() => resolveServe({ "approval-timeout": "soon" }, {}, {}, where)).toThrow(/--approval-timeout/);
    expect(() => resolveServe({ port: "http" }, {}, {}, where)).toThrow(/--port/);
    expect(() => resolveServe({ access: "root" }, {}, {}, where)).toThrow(/--access/);
  });
});

describe("cors", () => {
  const funnel = createFunnel();
  const app = "https://app.example.com";
  const url = `http://127.0.0.1:4747/fs?path=${encodeURIComponent(tmpdir())}`;
  const get = (h: ReturnType<typeof createHandler>, headers: Record<string, string> = {}) => h(new Request(url, { headers: { host: "127.0.0.1:4747", ...headers } }));
  const preflight = (h: ReturnType<typeof createHandler>, origin: string) =>
    h(new Request(url, { method: "OPTIONS", headers: { host: "127.0.0.1:4747", origin, "access-control-request-method": "POST" } }));

  it("normalizes one origin and refuses everything else", () => {
    expect(corsOrigin("https://app.example.com")).toBe(app);
    expect(corsOrigin("https://app.example.com/")).toBe(app);
    expect(corsOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    for (const bad of ["*", "app.example.com", "https://app.example.com/path", "ftp://x", "null", ""]) expect(() => corsOrigin(bad)).toThrow(/one origin/);
    expect(() => createHandler(funnel, { cors: "*" })).toThrow(/one origin/);
  });

  it("does nothing by default: no headers, other origins refused, no preflight", async () => {
    const h = createHandler(funnel, { fsRoots: [tmpdir()] });
    const res = await get(h, { origin: app });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect((await preflight(h, app)).status).toBe(403);
  });

  it("lets the configured origin through the origin check and adds headers", async () => {
    const h = createHandler(funnel, { fsRoots: [tmpdir()], cors: app });
    const res = await get(h, { origin: app });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(app);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("keeps the origin check for every other origin and the Host check for the configured one", async () => {
    const h = createHandler(funnel, { fsRoots: [tmpdir()], cors: app });
    const other = await get(h, { origin: "https://evil.example" });
    expect(other.status).toBe(403);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect((await get(h, { origin: "https://app.example.com.evil.example" })).status).toBe(403);
    const rebound = await get(h, { origin: app, host: "evil.example:4747" });
    expect(rebound.status).toBe(403);
  });

  it("answers the preflight for the configured origin only, before the token check", async () => {
    const h = createHandler(funnel, { fsRoots: [tmpdir()], cors: app, token: "s3cret" });
    const ok = await preflight(h, app);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(app);
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(ok.headers.get("access-control-allow-methods")).toContain("POST");
    const other = await preflight(h, "https://evil.example");
    expect(other.status).toBe(401);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("adds the headers to errors, so the browser can read a 401", async () => {
    const h = createHandler(funnel, { fsRoots: [tmpdir()], cors: app, token: "s3cret" });
    const res = await get(h, { origin: app });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(app);
    const authed = await get(h, { origin: app, authorization: "Bearer s3cret" });
    expect(authed.status).toBe(200);
  });
});
