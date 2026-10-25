import { timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Funnel } from "../funnel.js";
import {
  FunnelError,
  type ApprovalDecision,
  type FunnelEvent,
  type LoginSession,
  type ProviderId,
  type QuestionAnswers,
  type RunRequest,
  type Selection,
} from "../types.js";
import { BodyError, DEFAULT_MAX_BODY_BYTES, readJson } from "./body.js";
import { handleOpenAI, resolveOptionDirs, type OpenAIDefaults } from "./openai.js";
import { handleResponses } from "./responses.js";
import { errorBody, fail, statusOfError, tooBusy, type TrackedRun } from "./shared.js";
import { json, sse, sseHeaders } from "./sse.js";
import { createCwdGuard, insideRoots, real } from "../util/fs-roots.js";
import { RunQueue, waitForSlot, type RunLimits } from "../queue.js";
import { approvalReply } from "../providers/base.js";
import { isObject } from "../util/is-object.js";

/** `maxConcurrentRuns`, `maxQueuedRuns` and `queueTimeoutMs` limit the runs on `/run`, `/v1/chat/completions` and `/v1/responses`. */
export interface HandlerOptions extends RunLimits {
  /** Path prefix the routes live under, for example "/api/funnel". Default "". */
  basePath?: string;
  /**
   * Require `Authorization: Bearer <token>` on every request. Set this whenever the server is reachable by anyone but you.
   * Without a token the handler only answers requests addressed to a loopback host, an IP address or a Tailscale name,
   * from a page on the same host. A website open in the user's browser cannot start runs.
   */
  token?: string;
  /**
   * More host names to accept without a token, for the Host and Origin headers. ".example.com" also matches its subdomains.
   * "*" accepts any host and turns the check off.
   */
  allowedHosts?: string[];
  /** Accept `*.ts.net` hosts on requests that `tailscale serve` signed with a tailnet user. Funnel requests carry none. Default true. */
  tailscale?: boolean;
  /** Directories the folder picker may browse and runs may use as their project folder. Default: the home directory. */
  fsRoots?: string[];
  /** Defaults for the OpenAI-compatible endpoints, which cannot carry a full Selection. `openai.cwd` must be inside `fsRoots`. */
  openai?: OpenAIDefaults;
  /** Largest request body the handler reads, in bytes. Larger requests get a 413. Default 10 MB. */
  maxBodyBytes?: number;
  /** Seconds to wait for an approval before denying it. Default 300. */
  approvalTimeoutSec?: number;
  /**
   * One web origin, such as "https://app.example.com", that may call the API from a browser. Off by default.
   * Answers its preflight requests and adds CORS headers to its responses. Other origins get none, and the origin
   * check above stays on. A wildcard is not accepted.
   */
  cors?: string;
  /** Deadline in milliseconds for every run on `/run` and `/v1/chat/completions`. Default: none. */
  maxRunMs?: number;
}

/** The origin ("scheme://host[:port]") of a CORS setting. Throws on anything else, including "*". */
export function corsOrigin(value: string): string {
  try {
    const u = new URL(value);
    if ((u.protocol === "http:" || u.protocol === "https:") && u.origin === value.replace(/\/$/, "").toLowerCase()) return u.origin;
  } catch {
    /* falls through to the error */
  }
  throw new Error(`cors must be one origin such as "https://app.example.com", not "${value}".`);
}

const CORS_ALLOW = {
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
};

/** An approval or a question a run waits on. `resolve` takes the client's answer. */
interface PendingReply {
  resolve: (answer: unknown) => void;
}

/** The host name of a URL, or undefined when it does not parse. */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** True for localhost, 127.0.0.0/8 and ::1. */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** True for an IPv4 or IPv6 literal. DNS rebinding needs a domain name, so a literal is safe to accept as Host. */
function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

/** The body of `POST /approvals/:run/:id`. A plain decision stays a string, so callers that return strings see strings. */
function approvalAnswer(body: unknown): ApprovalDecision {
  const reply = approvalReply(body);
  return reply.message === undefined && reply.updatedInput === undefined ? reply.decision : reply;
}

/** The body of `POST /questions/:run/:id`: `{ answers }`, where null declines. Undefined when the body is malformed. */
function questionAnswer(body: unknown): QuestionAnswers | null | undefined {
  const answers = isObject(body) ? body.answers : undefined;
  if (answers === null) return null;
  if (!isObject(answers)) return undefined;
  return Object.values(answers).every((a) => Array.isArray(a) && a.every((v) => typeof v === "string")) ? (answers as QuestionAnswers) : undefined;
}

export function createHandler(funnel: Funnel, options: HandlerOptions = {}) {
  const base = (options.basePath ?? "").replace(/\/$/, "");
  const roots = (options.fsRoots ?? [homedir()]).map((r) => real(r) ?? resolve(r));
  // Keyed by `<kind>:<runId>:<id>`, kind "approval" or "question".
  const waiting = new Map<string, PendingReply>();
  const earlyAnswers = new Map<string, unknown>();
  const logins = new Map<string, LoginSession>();
  // One controller per live run, so POST /runs/:id/cancel can stop it.
  const runs = new Map<string, AbortController>();
  const queue = RunQueue.from(options);
  let seq = 0;

  /** Registers a run under a new id. Its signal aborts when the request closes or the run is cancelled. */
  const startRun = (requestSignal: AbortSignal): TrackedRun => {
    const id = `run_${++seq}_${Date.now().toString(36)}`;
    const controller = new AbortController();
    runs.set(id, controller);
    return { id, signal: AbortSignal.any([requestSignal, controller.signal]), timeoutMs: options.maxRunMs, queue, end: () => runs.delete(id) };
  };

  const cors = options.cors === undefined ? undefined : corsOrigin(options.cors);
  const corsMatch = (req: Request) => !!cors && req.headers.get("origin")?.toLowerCase() === cors;

  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const readBody = (req: Request) => readJson(req, maxBody);

  // Checks the real path, so a symlink inside a root cannot point a run or the picker outside it.
  const cwdAllowed = createCwdGuard(roots);
  const openai: OpenAIDefaults = options.openai?.cwd ? { ...options.openai, cwd: resolve(options.openai.cwd) } : (options.openai ?? {});
  if (openai.cwd && !cwdAllowed(openai.cwd)) {
    throw new Error(`openai.cwd ${openai.cwd} does not exist or is outside fsRoots. Add it to fsRoots or choose another folder.`);
  }
  // A Host that is a domain name we do not know means DNS rebinding. An Origin on another host means another website.
  const allowed = (options.allowedHosts ?? []).map((h) => h.toLowerCase());
  const listed = (name: string) => allowed.some((h) => h === "*" || h === name || (h.startsWith(".") && (name.endsWith(h) || name === h.slice(1))));
  const localOnly = (req: Request): string | undefined => {
    // Tailscale sets this on every Funnel request and strips it from the rest. Funnel is the public internet.
    if (req.headers.has("tailscale-funnel-request")) return "Requests through Tailscale Funnel need a token.";
    const host = req.headers.get("host")?.toLowerCase();
    const name = host && hostnameOf(`http://${host}`);
    if (host) {
      // tailscale serve keeps the Host and overwrites Tailscale-User-Login, so a request that has it came from the tailnet.
      const tailnet = options.tailscale !== false && !!name?.endsWith(".ts.net") && req.headers.has("tailscale-user-login");
      if (!name || !(isLoopback(name) || isIpLiteral(name) || tailnet || listed(name))) return `Host ${host} is not a local address.`;
    }
    const origin = req.headers.get("origin");
    if (!origin) return undefined;
    const from = hostnameOf(origin);
    const sameHost = !!host && origin.toLowerCase().replace(/^https?:\/\//, "") === host;
    if (!from || !(sameHost || isLoopback(from) || listed(from) || corsMatch(req))) return `Requests from ${origin} are refused.`;
    return undefined;
  };
  const tokenOk = (header: string | null) => {
    const a = Buffer.from(header ?? "");
    const b = Buffer.from(`Bearer ${options.token}`);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  async function run(req: Request): Promise<Response> {
    const body = (await readBody(req)) as Pick<RunRequest, "prompt" | "messages" | "tools" | "toolChoice" | "sessionId" | "system" | "attachments" | "responseSchema" | "maxOutputTokens" | "providerOptions" | "mcpServers" | "apiKey" | "planTool"> & {
      selection: Selection;
    };
    // Providers with no access levels (Ollama, API providers) have no machine to protect, so cwd means nothing to them.
    const provider = funnel.providers[body.selection?.provider];
    if ((!provider || provider.capabilities.access.length > 0) && !cwdAllowed(body.selection?.cwd ?? "")) {
      return json({ error: "cwd does not exist or is outside the allowed roots. Set fsRoots on the handler." }, 403);
    }
    const providerOptions = resolveOptionDirs(body.providerOptions, cwdAllowed);
    if (providerOptions === null) {
      return json({ error: "An addDirs entry in providerOptions does not exist or is outside the allowed roots. Set fsRoots on the handler." }, 403);
    }
    if (queue?.full(body.selection.provider)) {
      return tooBusy({ error: "Too many runs are waiting. Try again later.", code: "busy" });
    }
    const tracked = startRun(req.signal);
    const runId = tracked.id;
    const timeoutMs = (options.approvalTimeoutSec ?? 300) * 1000;
    // Approvals and questions this run is waiting on. An aborted or finished run answers them with their fallback
    // (deny, or no answer), so nothing outlives it.
    const pending = new Map<string, unknown>();
    // Set once the run is over. A request the provider makes after that, which can happen when the body is cancelled
    // between the event and the provider's call to onApproval or onQuestion, gets its fallback at once.
    let over = false;
    const settleAll = () => {
      over = true;
      for (const [key, fallback] of [...pending]) waiting.get(key)?.resolve(fallback);
    };
    /** Waits for the client's answer to one approval or question, or `fallback` on timeout or when the run ends. */
    const awaitClient = <T>(kind: "approval" | "question", id: string, fallback: T): Promise<T> =>
      new Promise<T>((resolveAnswer) => {
        if (over || tracked.signal.aborted) return resolveAnswer(fallback);
        const key = `${kind}:${runId}:${id}`;
        if (earlyAnswers.has(key)) {
          const early = earlyAnswers.get(key) as T;
          earlyAnswers.delete(key);
          return resolveAnswer(early);
        }
        const timer = setTimeout(() => finish(fallback), timeoutMs);
        timer.unref();
        const finish = (answer: unknown) => {
          clearTimeout(timer);
          waiting.delete(key);
          pending.delete(key);
          resolveAnswer(answer as T);
        };
        pending.set(key, fallback);
        waiting.set(key, { resolve: finish });
      });
    // Closing the request and cancelling the run by id both abort this signal.
    tracked.signal.addEventListener("abort", settleAll, { once: true });
    const input: RunRequest = {
      runId,
      selection: body.selection,
      prompt: body.prompt,
      messages: body.messages,
      tools: body.tools,
      toolChoice: body.toolChoice,
      system: body.system,
      attachments: body.attachments,
      responseSchema: body.responseSchema,
      maxOutputTokens: body.maxOutputTokens,
      sessionId: body.sessionId,
      signal: tracked.signal,
      timeoutMs: tracked.timeoutMs,
      providerOptions,
      mcpServers: body.mcpServers,
      apiKey: body.apiKey,
      planTool: body.planTool,
      onApproval: (request) => awaitClient<ApprovalDecision>("approval", request.id, "deny"),
      onQuestion: (request) => awaitClient<QuestionAnswers | null>("question", request.id, null),
    };
    const stream = funnel.stream(input);
    const events = (async function* (): AsyncGenerator<FunnelEvent | { type: "run"; runId: string }> {
      yield { type: "run", runId };
      try {
        const release = queue ? yield* waitForSlot(queue, body.selection.provider, tracked.signal) : () => undefined;
        if (!release) return yield { type: "done", text: "", finishReason: "cancelled" };
        try {
          for await (const e of stream) yield e;
        } finally {
          release();
        }
      } finally {
        settleAll();
        tracked.signal.removeEventListener("abort", settleAll);
        tracked.end();
      }
    })();
    // The generator may be blocked inside the provider, so a cancelled body settles the approvals itself.
    const cancel = () => {
      settleAll();
      tracked.end();
    };
    return new Response(sse(events, { onCancel: cancel }), { headers: sseHeaders });
  }

  async function login(id: ProviderId, req: Request): Promise<Response> {
    // `?device=1` asks for a device-code login, for a server whose browser is on another machine.
    const device = new URL(req.url).searchParams.get("device") === "1";
    const session = funnel.login(id, { signal: req.signal, device });
    const loginId = `login_${++seq}_${Date.now().toString(36)}`;
    logins.set(loginId, session);
    const events = (async function* () {
      yield { type: "login", loginId };
      try {
        yield* session;
      } finally {
        logins.delete(loginId);
      }
    })();
    return new Response(sse(events), { headers: sseHeaders });
  }

  async function listDirs(url: URL): Promise<Response> {
    const raw = url.searchParams.get("path") || roots[0]!;
    const asked = resolve(isAbsolute(raw) ? raw : join(roots[0]!, raw));
    const path = real(asked);
    // A missing path answers like an outside one unless it is inside, so the picker cannot probe the disk.
    if (!path || !insideRoots(roots, path)) {
      return path || !insideRoots(roots, asked) ? json({ error: "Path is outside the allowed roots." }, 403) : json({ error: "Cannot read directory." }, 404);
    }
    const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
    if (!entries) return json({ error: "Cannot read directory." }, 404);
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    const parent = dirname(path);
    return json({ path, name: basename(path), parent: insideRoots(roots, parent) && parent !== path ? parent : null, dirs });
  }

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let path = url.pathname;
    if (base) {
      if (!path.startsWith(base)) return json({ error: "Not found" }, 404);
      path = path.slice(base.length) || "/";
    }
    // The OpenAI routes answer in the OpenAI error shape. The others keep `{ error: string }`.
    const oai = path.startsWith("/v1/");
    if (options.token && !tokenOk(req.headers.get("authorization"))) {
      return oai ? fail(401, "Unauthorized", { code: "invalid_api_key" }) : json({ error: "Unauthorized" }, 401);
    }
    const refused = options.token ? undefined : localOnly(req);
    if (refused) {
      const message = `${refused} Set a token or allowedHosts on the handler to accept it.`;
      return oai ? fail(403, message, { code: "host_not_allowed" }) : json({ error: message }, 403);
    }
    try {
      const seg = path.split("/").filter(Boolean);
      const m = req.method;

      if (path === "/v1/responses") return await handleResponses(funnel, req, openai, cwdAllowed, maxBody, startRun);
      if (path.startsWith("/v1/")) return await handleOpenAI(funnel, req, path, openai, cwdAllowed, maxBody, startRun);

      if (m === "GET" && path === "/providers") return json(await funnel.overview());
      if (m === "GET" && path === "/fs") return await listDirs(url);
      if (m === "POST" && path === "/run") return await run(req);

      if (seg[0] === "providers" && seg[1]) {
        const id = seg[1] as ProviderId;
        if (!funnel.providers[id]) return json({ error: `Unknown provider ${id}` }, 404);
        if (m === "GET" && seg[2] === "models" && !seg[3]) return json(await funnel.models(id));
        if (m === "POST" && seg[2] === "models" && seg[3] === "pull") {
          const { name } = (await readBody(req)) as { name?: string };
          if (!name) return json({ error: "name is required" }, 400);
          return new Response(sse(funnel.pullModel(id, name, { signal: req.signal })), { headers: sseHeaders });
        }
        if (m === "POST" && seg[2] === "models" && seg[3] === "delete") {
          const { name } = (await readBody(req)) as { name?: string };
          if (!name) return json({ error: "name is required" }, 400);
          await funnel.deleteModel(id, name);
          return json({ ok: true });
        }
        if (m === "GET" && seg[2] === "auth") return json(await funnel.authStatus(id));
        if (m === "POST" && seg[2] === "login") return await login(id, req);
        if (m === "POST" && seg[2] === "logout") {
          await funnel.logout(id);
          return json({ ok: true });
        }
        if (m === "POST" && seg[2] === "update") return json(await funnel.update(id));
      }

      if (m === "POST" && seg[0] === "runs" && seg[1] && seg[2] === "cancel" && !seg[3]) {
        const controller = runs.get(seg[1]);
        if (!controller) return json({ error: "Unknown run" }, 404);
        controller.abort();
        return json({ ok: true });
      }

      // Live sessions. They exist only when the funnel was made with `sessions.keepAlive`.
      if (seg[0] === "sessions") {
        if (!funnel.sessionsEnabled) throw new FunnelError("Live sessions are off. Create the funnel with sessions: { keepAlive: true }.", "unsupported");
        const provider = (url.searchParams.get("provider") || undefined) as ProviderId | undefined;
        if (m === "GET" && !seg[1]) return json(funnel.sessions());
        if (m === "POST" && seg[1] && seg[2] === "steer" && !seg[3]) {
          const { text, provider: from } = (await readBody(req)) as { text?: unknown; provider?: ProviderId };
          if (typeof text !== "string" || !text) return json({ error: "text is required" }, 400);
          await funnel.steer(seg[1], text, from ?? provider);
          return json({ ok: true });
        }
        if (m === "DELETE" && seg[1] && !seg[2]) {
          return funnel.closeSession(seg[1], provider) ? json({ ok: true }) : json({ error: "Unknown session" }, 404);
        }
      }

      if (m === "POST" && seg[0] === "logins" && seg[1]) {
        const session = logins.get(seg[1]);
        if (!session) return json({ error: "Unknown login" }, 404);
        if (seg[2] === "code") {
          const { code } = (await readBody(req)) as { code: string };
          session.sendCode(code);
        } else if (seg[2] === "cancel") session.cancel();
        return json({ ok: true });
      }

      if (m === "POST" && (seg[0] === "approvals" || seg[0] === "questions") && seg[1] && seg[2] && !seg[3]) {
        const body = await readBody(req);
        const kind = seg[0] === "approvals" ? "approval" : "question";
        const answer = kind === "approval" ? approvalAnswer(body) : questionAnswer(body);
        if (answer === undefined) return json({ error: "answers must map question ids to lists of strings, or be null" }, 400);
        const key = `${kind}:${seg[1]}:${seg[2]}`;
        const pending = waiting.get(key);
        if (pending) pending.resolve(answer);
        else if (runs.has(seg[1])) {
          // The client can answer before the provider awaits. Keep the answer briefly. An unknown run never asks.
          earlyAnswers.set(key, answer);
          setTimeout(() => earlyAnswers.delete(key), 60_000).unref();
        }
        return json({ ok: true });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      if (err instanceof BodyError) return oai ? fail(err.status, err.message, { code: err.status === 413 ? "request_too_large" : "invalid_json" }) : json({ error: err.message }, err.status);
      const status = statusOfError(err);
      const message = err instanceof Error ? err.message : String(err);
      if (oai) return json(errorBody(message, { type: "cli_funnel_error", code: (err as FunnelError).code }), status);
      return json({ error: message, code: (err as FunnelError).code }, status);
    }
  }

  return async function handle(req: Request): Promise<Response> {
    if (!corsMatch(req)) return handleRequest(req);
    const headers = { "access-control-allow-origin": cors!, vary: "Origin" };
    // A preflight carries no credentials, so it is answered before the token check. It reveals nothing.
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, ...CORS_ALLOW } });
    const res = await handleRequest(req);
    const merged = new Headers(res.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(res.body, { status: res.status, headers: merged });
  };
}
