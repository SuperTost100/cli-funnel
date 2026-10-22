import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { HandlerOptions } from "../server/handler.js";
import type { OpenAICompatibleEndpoint } from "../providers/openai-compatible.js";
import type { SessionOptions } from "../sessions.js";
import { ACCESS_LEVELS, type AccessLevel } from "../types.js";
import { isObject } from "../util/is-object.js";
import { UsageError } from "./run-input.js";

/** What `serve --config` reads. The handler options keep their names, so the file mirrors `createHandler`. */
export interface ServeConfig extends Pick<HandlerOptions, "basePath" | "token" | "allowedHosts" | "tailscale" | "fsRoots" | "approvalTimeoutSec" | "maxRunMs" | "cors" | "openai" | "maxConcurrentRuns" | "maxQueuedRuns" | "queueTimeoutMs"> {
  port?: number;
  host?: string;
  /** Project folder for the OpenAI-compatible endpoints. Same as `openai.cwd`. */
  cwd?: string;
  /** Access level for the OpenAI-compatible endpoints. Same as `openai.access`. */
  access?: AccessLevel;
  openaiCompatible?: OpenAICompatibleEndpoint[];
  /** Append one JSON line per run to this file. */
  logJsonl?: string;
  /** Add the prompt and the answer text to each log line. */
  logContent?: boolean;
  /** Live sessions, as in `createFunnel({ sessions })`. `idleMs` and `max` need `keepAlive: true`. */
  sessions?: SessionOptions;
}

const KEYS = [
  "port", "host", "cwd", "access", "token", "allowedHosts", "tailscale", "fsRoots", "approvalTimeoutSec", "cors", "basePath", "openai", "openaiCompatible",
  "logJsonl", "logContent", "maxRunMs", "sessions", "maxConcurrentRuns", "maxQueuedRuns", "queueTimeoutMs",
] as const;

/** How long `serve` lets a run take when neither --timeout nor `maxRunMs` says otherwise. */
export const SERVE_TIMEOUT_SEC = 1800;

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isCount = (v: unknown, min: number): v is number => Number.isInteger(v) && (v as number) >= min;
const SESSION_KEYS = ["keepAlive", "idleMs", "max"];

/** `maxConcurrentRuns`: a count, or `{ total?, perProvider? }` where `perProvider` is a count or a count per provider id. */
function isConcurrency(v: unknown): boolean {
  if (isCount(v, 1)) return true;
  if (!isObject(v) || Object.keys(v).some((k) => k !== "total" && k !== "perProvider")) return false;
  const per = v.perProvider;
  return (v.total === undefined || isCount(v.total, 1)) && (per === undefined || isCount(per, 1) || (isObject(per) && Object.values(per).every((n) => isCount(n, 1))));
}

/**
 * Reads and checks a serve config file. A key it does not know is an error, because a misspelled `fsRoots`
 * would silently fall back to the default and open more than the file meant to. Relative paths resolve against the file's folder.
 */
export function readServeConfig(path: string): ServeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(`Cannot read --config ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  return parseServeConfig(raw, path);
}

export function parseServeConfig(raw: unknown, path: string): ServeConfig {
  const bad = (msg: string) => new UsageError(`${path}: ${msg}`);
  if (!isObject(raw)) throw bad("must be a JSON object.");
  for (const k of Object.keys(raw)) if (!(KEYS as readonly string[]).includes(k)) throw bad(`unknown key "${k}". Known keys: ${KEYS.join(", ")}.`);
  const need = (key: string, ok: boolean, what: string) => {
    if (raw[key] !== undefined && !ok) throw bad(`"${key}" must be ${what}.`);
  };
  need("port", Number.isInteger(raw.port) && (raw.port as number) >= 0 && (raw.port as number) < 65536, "a port number");
  need("host", typeof raw.host === "string", "a string");
  need("cwd", typeof raw.cwd === "string", "a string");
  need("access", (ACCESS_LEVELS as readonly unknown[]).includes(raw.access), `one of ${ACCESS_LEVELS.join(", ")}`);
  need("token", typeof raw.token === "string" && raw.token !== "", "a non-empty string");
  need("allowedHosts", isStrings(raw.allowedHosts), "a list of strings");
  need("tailscale", typeof raw.tailscale === "boolean", "true or false");
  need("fsRoots", isStrings(raw.fsRoots), "a list of folders");
  need("approvalTimeoutSec", typeof raw.approvalTimeoutSec === "number" && raw.approvalTimeoutSec > 0, "a positive number of seconds");
  need("maxRunMs", typeof raw.maxRunMs === "number" && raw.maxRunMs >= 0, "a number of milliseconds, 0 for no limit");
  need("maxConcurrentRuns", isConcurrency(raw.maxConcurrentRuns), "a whole number above 0, or { total, perProvider } with whole numbers above 0");
  need("maxQueuedRuns", isCount(raw.maxQueuedRuns, 0), "a whole number, 0 for no waiting");
  need("queueTimeoutMs", typeof raw.queueTimeoutMs === "number" && raw.queueTimeoutMs > 0, "a positive number of milliseconds");
  const sessions = raw.sessions;
  need("sessions", isObject(sessions), "an object with keepAlive, idleMs and max");
  if (isObject(sessions)) {
    for (const k of Object.keys(sessions)) if (!SESSION_KEYS.includes(k)) throw bad(`unknown key "sessions.${k}". Known keys: ${SESSION_KEYS.join(", ")}.`);
    if (sessions.keepAlive !== undefined && typeof sessions.keepAlive !== "boolean") throw bad(`"sessions.keepAlive" must be true or false.`);
    if (sessions.idleMs !== undefined && !(typeof sessions.idleMs === "number" && sessions.idleMs > 0)) throw bad(`"sessions.idleMs" must be a positive number of milliseconds.`);
    if (sessions.max !== undefined && !isCount(sessions.max, 1)) throw bad(`"sessions.max" must be a whole number above 0.`);
  }
  need("cors", typeof raw.cors === "string", "one origin");
  need("basePath", typeof raw.basePath === "string", "a string");
  need("openai", isObject(raw.openai), "an object with cwd and access");
  need("openaiCompatible", Array.isArray(raw.openaiCompatible), "a list of { id, name, baseUrl, apiKey?, models? }");
  need("logJsonl", typeof raw.logJsonl === "string" && raw.logJsonl !== "", "a file path");
  need("logContent", typeof raw.logContent === "boolean", "true or false");
  const config = raw as ServeConfig;
  const dir = dirname(resolve(path));
  const abs = (p: string) => resolve(dir, p);
  if (config.fsRoots) config.fsRoots = config.fsRoots.map(abs);
  if (config.cwd) config.cwd = abs(config.cwd);
  if (config.logJsonl) config.logJsonl = abs(config.logJsonl);
  if (config.openai?.cwd) config.openai = { ...config.openai, cwd: abs(config.openai.cwd) };
  return config;
}

export interface ServeFlags {
  port?: string;
  host?: string;
  cwd?: string;
  access?: string;
  token?: string;
  "fs-root"?: string[];
  "approval-timeout"?: string;
  timeout?: string;
  cors?: string;
  "log-jsonl"?: string;
  "log-content"?: boolean;
  "keep-alive"?: boolean;
  "session-idle"?: string;
  "max-sessions"?: string;
  "max-concurrent"?: string;
  "max-queued"?: string;
  "queue-timeout"?: string;
}

export interface ServeSettings {
  /** Where to write the run log, and whether lines carry the prompt and text. */
  log?: { file: string; content: boolean };
  host: string;
  port: number;
  token?: string;
  handler: HandlerOptions;
  /** Set when live sessions are on. Pass it to `createFunnel({ sessions })`. */
  sessions?: SessionOptions;
}

/** A number of seconds, 0 included. */
export const seconds = (flag: string, v: string) => {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n) || n < 0) throw new UsageError(`${flag} takes a number of seconds, got "${v}".`);
  return n;
};

const positive = (flag: string, v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number, got "${v}".`);
  return n;
};

/** A whole number of at least `min`. */
const count = (flag: string, v: string, min: number) => {
  if (!/^\d+$/.test(v.trim()) || Number(v) < min) throw new UsageError(`${flag} must be a whole number ${min === 0 ? "of 0 or more" : `above ${min - 1}`}, got "${v}".`);
  return Number(v);
};

/**
 * Merges flags, the config file and the environment into what `serve` runs with. A flag beats the file, the file beats the environment.
 * `--fs-root` replaces the file's `fsRoots` instead of adding to it. With no roots given anywhere the folders are the home directory and the project folder.
 */
export function resolveServe(flags: ServeFlags, config: ServeConfig, env: NodeJS.ProcessEnv, where: { cwd: string; home: string }): ServeSettings {
  const roots = flags["fs-root"]?.length ? flags["fs-root"].map((r) => resolve(where.cwd, r)) : config.fsRoots;
  const access = flags.access ?? config.openai?.access ?? config.access ?? "accept-edits";
  if (!(ACCESS_LEVELS as readonly string[]).includes(access)) throw new UsageError(`--access must be one of ${ACCESS_LEVELS.join(", ")}.`);
  // The OpenAI endpoints run in one folder. When the roots are explicit, default to the first one so the default folder is allowed.
  const cwd = flags.cwd ?? config.openai?.cwd ?? config.cwd ?? roots?.[0] ?? where.cwd;
  const envHosts = env.CLI_FUNNEL_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
  const token = flags.token ?? config.token ?? (env.CLI_FUNNEL_TOKEN || undefined);
  const timeout = flags["approval-timeout"] !== undefined ? positive("--approval-timeout", flags["approval-timeout"]) : config.approvalTimeoutSec;
  // 0 turns the deadline off.
  const maxRunMs = flags.timeout !== undefined ? seconds("--timeout", flags.timeout) * 1000 : config.maxRunMs ?? SERVE_TIMEOUT_SEC * 1000;
  const port = flags.port !== undefined ? Number(flags.port) : config.port ?? 4747;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be a port number, got "${flags.port}".`);
  const logFile = flags["log-jsonl"] ?? config.logJsonl;
  const logContent = flags["log-content"] ?? config.logContent ?? false;
  if (logContent && !logFile) throw new UsageError("--log-content needs --log-jsonl, since it only adds fields to that log.");
  const keepAlive = flags["keep-alive"] ?? config.sessions?.keepAlive ?? false;
  const idleMs = flags["session-idle"] !== undefined ? positive("--session-idle", flags["session-idle"]) * 1000 : config.sessions?.idleMs;
  const maxSessions = flags["max-sessions"] !== undefined ? count("--max-sessions", flags["max-sessions"], 1) : config.sessions?.max;
  if (!keepAlive && (idleMs !== undefined || maxSessions !== undefined)) {
    throw new UsageError("--session-idle and --max-sessions need --keep-alive, since they only tune live sessions.");
  }
  const maxConcurrentRuns = flags["max-concurrent"] !== undefined ? count("--max-concurrent", flags["max-concurrent"], 1) : config.maxConcurrentRuns;
  const maxQueuedRuns = flags["max-queued"] !== undefined ? count("--max-queued", flags["max-queued"], 0) : config.maxQueuedRuns;
  const queueTimeoutMs = flags["queue-timeout"] !== undefined ? positive("--queue-timeout", flags["queue-timeout"]) * 1000 : config.queueTimeoutMs;
  if ((maxQueuedRuns !== undefined || queueTimeoutMs !== undefined) && maxConcurrentRuns === undefined) {
    throw new UsageError("--max-queued and --queue-timeout need --max-concurrent, since nothing queues without a run limit.");
  }
  return {
    host: flags.host ?? config.host ?? "127.0.0.1",
    port,
    token,
    log: logFile ? { file: logFile, content: logContent } : undefined,
    handler: {
      basePath: config.basePath,
      token,
      allowedHosts: config.allowedHosts ?? envHosts,
      tailscale: config.tailscale,
      fsRoots: roots ?? [where.home, cwd],
      openai: { ...config.openai, cwd, access: access as AccessLevel },
      approvalTimeoutSec: timeout,
      maxRunMs,
      cors: flags.cors ?? config.cors,
      maxConcurrentRuns,
      maxQueuedRuns,
      queueTimeoutMs,
    },
    sessions: keepAlive ? { keepAlive, idleMs, max: maxSessions } : undefined,
  };
}
