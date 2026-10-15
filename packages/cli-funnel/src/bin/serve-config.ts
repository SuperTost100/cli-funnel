import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { HandlerOptions } from "../server/handler.js";
import type { OpenAICompatibleEndpoint } from "../providers/openai-compatible.js";
import { ACCESS_LEVELS, type AccessLevel } from "../types.js";
import { UsageError } from "./run-input.js";

/** What `serve --config` reads. The handler options keep their names, so the file mirrors `createHandler`. */
export interface ServeConfig extends Pick<HandlerOptions, "basePath" | "token" | "allowedHosts" | "tailscale" | "fsRoots" | "approvalTimeoutSec" | "cors" | "openai"> {
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
}

const KEYS = [
  "port", "host", "cwd", "access", "token", "allowedHosts", "tailscale", "fsRoots", "approvalTimeoutSec", "cors", "basePath", "openai", "openaiCompatible",
  "logJsonl", "logContent",
] as const;

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

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
  cors?: string;
  "log-jsonl"?: string;
  "log-content"?: boolean;
}

export interface ServeSettings {
  /** Where to write the run log, and whether lines carry the prompt and text. */
  log?: { file: string; content: boolean };
  host: string;
  port: number;
  token?: string;
  handler: HandlerOptions;
  openaiCompatible?: OpenAICompatibleEndpoint[];
}

const positive = (flag: string, v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number, got "${v}".`);
  return n;
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
  const port = flags.port !== undefined ? Number(flags.port) : config.port ?? 4747;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be a port number, got "${flags.port}".`);
  const logFile = flags["log-jsonl"] ?? config.logJsonl;
  const logContent = flags["log-content"] ?? config.logContent ?? false;
  if (logContent && !logFile) throw new UsageError("--log-content needs --log-jsonl, since it only adds fields to that log.");
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
      cors: flags.cors ?? config.cors,
    },
    openaiCompatible: config.openaiCompatible,
  };
}
