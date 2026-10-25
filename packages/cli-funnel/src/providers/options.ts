// Value checks for `providerOptions`. Each provider maps the checked values to its own flags.
import { isAbsolute } from "node:path";
import { FunnelError, type AccessLevel, type McpServer, type ProviderOptions, type RunInput } from "../types.js";
import { isObject } from "../util/is-object.js";

/** `--name=value` in one argument, so a value that starts with a dash is never read as a flag. */
export const flag = (name: string, value: string | number): string => `${name}=${value}`;

function bad(message: string): never {
  throw new FunnelError(message, "invalid-selection");
}


/** The entry for `id`, or `{}`. Unknown keys fail, so a typo never turns into a silently ignored option. */
export function optionsFor<K extends keyof ProviderOptions>(input: RunInput, id: K, known: readonly string[]): NonNullable<ProviderOptions[K]> {
  const raw: unknown = input.providerOptions?.[id];
  if (raw === undefined) return {} as NonNullable<ProviderOptions[K]>;
  if (!isObject(raw)) bad(`providerOptions.${id} must be an object.`);
  const unknown = Object.keys(raw).filter((k) => !known.includes(k));
  if (unknown.length) bad(`Unknown ${id} option ${unknown.join(", ")}. Known: ${known.join(", ")}.`);
  return raw as NonNullable<ProviderOptions[K]>;
}

/** Fails when the selection's access level is not in `levels`. */
export function requireAccess(access: AccessLevel, levels: readonly AccessLevel[], what: string): void {
  if (!levels.includes(access)) bad(`${what} is not allowed at access "${access}". Allowed at: ${levels.join(", ")}.`);
}

/** A list of non-empty strings. A single string counts as a list of one, which is what `--opt key=value` sends. */
export function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.every((s) => typeof s === "string" && s.length > 0)) bad(`${name} must be a list of non-empty strings.`);
  return list;
}

/** A list of absolute paths. */
export function dirList(value: unknown, name: string): string[] | undefined {
  const list = stringList(value, name);
  const relative = list?.find((d) => !isAbsolute(d));
  if (relative !== undefined) bad(`${name} must hold absolute paths: ${relative}`);
  return list;
}

export function str(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) bad(`${name} must be a non-empty string.`);
  return value;
}

export function bool(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") bad(`${name} must be true or false.`);
  return value;
}

export function positive(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) bad(`${name} must be a number above 0.`);
  return value;
}

export function oneOf<T extends string>(value: unknown, name: string, choices: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!choices.includes(value as T)) bad(`${name} must be one of ${choices.join(", ")}.`);
  return value as T;
}

export function object(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) bad(`${name} must be an object.`);
  return value;
}

const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MCP_KEYS: Record<McpServer["type"], readonly string[]> = {
  http: ["type", "url", "headers", "toolTimeoutSec", "autoApprove"],
  stdio: ["type", "command", "args", "env", "toolTimeoutSec"],
};

function stringRecord(value: unknown, name: string): Record<string, string> | undefined {
  const o = object(value, name);
  if (o && !Object.values(o).every((v) => typeof v === "string")) bad(`${name} must map names to strings.`);
  return o as Record<string, string> | undefined;
}

/**
 * Checks `RunInput.mcpServers` and returns the servers as `[name, server]` pairs, empty when there are none. `kinds`
 * are the types the provider can attach. HTTP servers start no process, so every level but `none` takes them. A stdio
 * server runs a command before any permission check, so only `full` takes it.
 */
export function mcpServersFor(input: RunInput, kinds: readonly McpServer["type"][], provider: string = input.selection.provider): [string, McpServer][] {
  const servers = object(input.mcpServers, "mcpServers");
  if (!servers || !Object.keys(servers).length) return [];
  const access = input.selection.access;
  return Object.entries(servers).map(([name, raw]) => {
    const where = `mcpServers.${name}`;
    if (!MCP_NAME.test(name)) bad(`MCP server name "${name}" must be 1 to 64 letters, digits, _ or -.`);
    const def = object(raw, where)!;
    const type = oneOf(def.type, `${where}.type`, ["http", "stdio"] as const);
    if (!type) bad(`${where}.type must be "http" or "stdio".`);
    if (!kinds.includes(type)) {
      throw new FunnelError(`${provider} cannot attach ${type} MCP servers.${kinds.length ? ` It takes: ${kinds.join(", ")}.` : ""}`, "unsupported");
    }
    const unknown = Object.keys(def).filter((k) => !MCP_KEYS[type].includes(k));
    if (unknown.length) bad(`Unknown key ${unknown.join(", ")} in ${where}. Known: ${MCP_KEYS[type].join(", ")}.`);
    positive(def.toolTimeoutSec, `${where}.toolTimeoutSec`);
    if (type === "http") {
      const url = str(def.url, `${where}.url`);
      if (!url || !/^https?:\/\//i.test(url)) bad(`${where}.url must be an http or https URL.`);
      stringRecord(def.headers, `${where}.headers`);
      bool(def.autoApprove, `${where}.autoApprove`);
      requireAccess(access ?? "none", ["supervised", "accept-edits", "auto", "full"], "An HTTP MCP server");
    } else {
      if (!str(def.command, `${where}.command`)) bad(`${where}.command is required.`);
      if (def.args !== undefined && (!Array.isArray(def.args) || !def.args.every((a) => typeof a === "string"))) bad(`${where}.args must be a list of strings.`);
      stringRecord(def.env, `${where}.env`);
      requireAccess(access ?? "none", ["full"], "A stdio MCP server");
    }
    return [name, def as unknown as McpServer];
  });
}

export { bad as invalidOption };
