import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Funnel } from "../funnel.js";
import {
  FunnelError,
  type ApprovalDecision,
  type FunnelEvent,
  type LoginSession,
  type ProviderId,
  type RunInput,
  type Selection,
} from "../types.js";
import { handleOpenAI, type OpenAIDefaults } from "./openai.js";
import { json, sse, sseHeaders } from "./sse.js";

export interface HandlerOptions {
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
  /** Defaults for the OpenAI-compatible endpoints, which cannot carry a full Selection. */
  openai?: OpenAIDefaults;
  /** Seconds to wait for an approval before denying it. Default 300. */
  approvalTimeoutSec?: number;
}

interface PendingApproval {
  resolve: (d: ApprovalDecision) => void;
}

/** The path with symlinks resolved, or undefined when it does not exist. */
function real(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
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

export function createHandler(funnel: Funnel, options: HandlerOptions = {}) {
  const base = (options.basePath ?? "").replace(/\/$/, "");
  const roots = (options.fsRoots ?? [homedir()]).map((r) => real(r) ?? resolve(r));
  const approvals = new Map<string, PendingApproval>();
  const earlyDecisions = new Map<string, ApprovalDecision>();
  const logins = new Map<string, LoginSession>();
  let seq = 0;

  const insideRoots = (p: string) => roots.some((r) => p === r || p.startsWith(r + sep));
  // Checks the real path, so a symlink inside a root cannot point a run or the picker outside it.
  const cwdAllowed = (cwd: string) => {
    const p = isAbsolute(cwd) ? real(cwd) : undefined;
    return !!p && insideRoots(p);
  };
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
    if (!from || !(sameHost || isLoopback(from) || listed(from))) return `Requests from ${origin} are refused.`;
    return undefined;
  };
  const tokenOk = (header: string | null) => {
    const a = Buffer.from(header ?? "");
    const b = Buffer.from(`Bearer ${options.token}`);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  async function run(req: Request): Promise<Response> {
    const body = (await req.json()) as Pick<RunInput, "prompt" | "sessionId" | "system" | "attachments" | "responseSchema" | "maxOutputTokens"> & {
      selection: Selection;
    };
    if (!cwdAllowed(body.selection?.cwd ?? "")) {
      return json({ error: "cwd does not exist or is outside the allowed roots. Set fsRoots on the handler." }, 403);
    }
    const runId = `run_${++seq}_${Date.now().toString(36)}`;
    const timeoutMs = (options.approvalTimeoutSec ?? 300) * 1000;
    const input: RunInput = {
      selection: body.selection,
      prompt: body.prompt,
      system: body.system,
      attachments: body.attachments,
      responseSchema: body.responseSchema,
      maxOutputTokens: body.maxOutputTokens,
      sessionId: body.sessionId,
      signal: req.signal,
      onApproval: (request) =>
        new Promise<ApprovalDecision>((resolveDecision) => {
          const key = `${runId}:${request.id}`;
          const early = earlyDecisions.get(key);
          if (early) {
            earlyDecisions.delete(key);
            return resolveDecision(early);
          }
          const timer = setTimeout(() => finish("deny"), timeoutMs);
          const finish = (d: ApprovalDecision) => {
            clearTimeout(timer);
            approvals.delete(key);
            resolveDecision(d);
          };
          approvals.set(key, { resolve: finish });
        }),
    };
    const stream = funnel.stream(input);
    const events = (async function* (): AsyncGenerator<FunnelEvent | { type: "run"; runId: string }> {
      yield { type: "run", runId };
      try {
        for await (const e of stream) yield e;
      } catch (err) {
        yield { type: "error", message: err instanceof Error ? err.message : String(err), code: (err as FunnelError).code };
      }
    })();
    return new Response(sse(events), { headers: sseHeaders });
  }

  async function login(id: ProviderId, req: Request): Promise<Response> {
    const session = funnel.login(id, { signal: req.signal });
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
    if (!path || !insideRoots(path)) {
      return path || !insideRoots(asked) ? json({ error: "Path is outside the allowed roots." }, 403) : json({ error: "Cannot read directory." }, 404);
    }
    const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
    if (!entries) return json({ error: "Cannot read directory." }, 404);
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    const parent = dirname(path);
    return json({ path, name: basename(path), parent: insideRoots(parent) && parent !== path ? parent : null, dirs });
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let path = url.pathname;
    if (base) {
      if (!path.startsWith(base)) return json({ error: "Not found" }, 404);
      path = path.slice(base.length) || "/";
    }
    if (options.token && !tokenOk(req.headers.get("authorization"))) {
      return json({ error: "Unauthorized" }, 401);
    }
    const refused = options.token ? undefined : localOnly(req);
    if (refused) return json({ error: `${refused} Set a token or allowedHosts on the handler to accept it.` }, 403);
    try {
      const seg = path.split("/").filter(Boolean);
      const m = req.method;

      if (path.startsWith("/v1/")) return await handleOpenAI(funnel, req, path, options.openai, cwdAllowed);

      if (m === "GET" && path === "/providers") return json(await funnel.overview());
      if (m === "GET" && path === "/fs") return await listDirs(url);
      if (m === "POST" && path === "/run") return await run(req);

      if (seg[0] === "providers" && seg[1]) {
        const id = seg[1] as ProviderId;
        if (!funnel.providers[id]) return json({ error: `Unknown provider ${id}` }, 404);
        if (m === "GET" && seg[2] === "models" && !seg[3]) return json(await funnel.models(id));
        if (m === "POST" && seg[2] === "models" && seg[3] === "pull") {
          const { name } = (await req.json()) as { name?: string };
          if (!name) return json({ error: "name is required" }, 400);
          return new Response(sse(funnel.pullModel(id, name, { signal: req.signal })), { headers: sseHeaders });
        }
        if (m === "POST" && seg[2] === "models" && seg[3] === "delete") {
          const { name } = (await req.json()) as { name?: string };
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

      if (m === "POST" && seg[0] === "logins" && seg[1]) {
        const session = logins.get(seg[1]);
        if (!session) return json({ error: "Unknown login" }, 404);
        if (seg[2] === "code") {
          const { code } = (await req.json()) as { code: string };
          session.sendCode(code);
        } else if (seg[2] === "cancel") session.cancel();
        return json({ ok: true });
      }

      if (m === "POST" && seg[0] === "approvals" && seg[1] && seg[2]) {
        const key = `${seg[1]}:${seg[2]}`;
        const { decision } = (await req.json()) as { decision: ApprovalDecision };
        const answer: ApprovalDecision = decision === "allow" ? "allow" : "deny";
        const pending = approvals.get(key);
        if (pending) pending.resolve(answer);
        else {
          // The client can answer before the provider awaits. Keep the answer briefly.
          earlyDecisions.set(key, answer);
          setTimeout(() => earlyDecisions.delete(key), 60_000).unref();
        }
        return json({ ok: true });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      const status = err instanceof FunnelError ? (err.code === "invalid-selection" ? 400 : 409) : 500;
      return json({ error: err instanceof Error ? err.message : String(err), code: (err as FunnelError).code }, status);
    }
  };
}
