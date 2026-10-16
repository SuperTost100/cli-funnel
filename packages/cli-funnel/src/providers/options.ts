// Value checks for `providerOptions`. Each provider maps the checked values to its own flags.
import { isAbsolute } from "node:path";
import { FunnelError, type AccessLevel, type ProviderOptions, type RunInput } from "../types.js";

/** `--name=value` in one argument, so a value that starts with a dash is never read as a flag. */
export const flag = (name: string, value: string | number): string => `${name}=${value}`;

function bad(message: string): never {
  throw new FunnelError(message, "invalid-selection");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

export { bad as invalidOption };
