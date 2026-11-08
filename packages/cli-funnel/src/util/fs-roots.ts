import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

/** The path with symlinks resolved, or undefined when it does not exist. */
export function real(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** True when `p` is one of `roots` or sits below one. Both must be resolved already, see `real`. */
export const insideRoots = (roots: string[], p: string): boolean => roots.some((r) => p === r || p.startsWith(r + sep));

/** Returns the real path of a folder a run may use, or undefined when the run may not use it. */
export type CwdGuard = (cwd: string) => string | undefined;

/**
 * Decides whether a run may use a folder as its project folder. The folder must be absolute, must exist and must sit
 * inside one of `roots` after symlinks are resolved. A symlink inside a root cannot point a run outside it.
 * Returns the resolved path, and the run must use that path: the original one could be a symlink that is pointed
 * elsewhere between this check and the start of the process. Undefined means refused.
 * Same rule as `fsRoots` on the HTTP handler. Default root: the home directory.
 */
export function createCwdGuard(roots: string[] = [homedir()]): CwdGuard {
  const resolved = roots.map((r) => real(r) ?? resolve(r));
  return (cwd) => {
    const p = isAbsolute(cwd) ? real(cwd) : undefined;
    return p && insideRoots(resolved, p) ? p : undefined;
  };
}
