import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FunnelError } from "../types.js";

/** Root for folders cli-funnel owns. Lives under the user's cache dir, never in a shared temp dir. */
function funnelCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "cli-funnel");
}

/** Lowercase letters, digits, `_` and `-`, up to 40: a name that is safe in a folder name. Lowercase only, since macOS and Windows treat `Notes` and `notes` as one folder. */
export const WORKSPACE_NAME = /^[a-z0-9_-]{1,40}$/;

/**
 * `name` for the shared folder, `name.<caller>` for a caller's own. A caller's name cannot hold a dot, so what follows
 * the first dot is always a whole name and never the start of another suffix. The name is checked here too, since a
 * folder name is built from it, whoever calls this.
 */
export function workspaceFor(name: string, caller: string | undefined): string {
  if (caller === undefined) return name;
  if (typeof caller !== "string" || !WORKSPACE_NAME.test(caller)) throw new FunnelError("workspaceName must be 1 to 40 lowercase letters, digits, _ or -.", "invalid-selection");
  return `${name}.${caller}`;
}

/** Where `ownedWorkspace(name, …)` puts its folder, without creating it. */
export const workspacePath = (name: string): string => join(funnelCacheDir(), "workspaces", name);

/**
 * Variables that point git at another repository or change where it stops looking for one. A CLI at access `none` runs
 * in a folder with a git marker of its own so it reads no instructions from above, and these would send it to someone
 * else's repository, or past its own root, instead. A value of
 * `undefined` removes the variable from the child's environment.
 */
export const NO_GIT_ENV: Record<string, undefined> = { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_CEILING_DIRECTORIES: undefined };

/**
 * Returns a private folder that holds only `files`, for runs that must not see the user's project. A key that ends in a
 * slash is an empty folder.
 * Files are rewritten when their content differs, through a rename so a concurrent run never reads half a file.
 */
export async function ownedWorkspace(name: string, files: Record<string, string>): Promise<string> {
  const dir = workspacePath(name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [rel, content] of Object.entries(files)) {
    // A name that ends in a slash is an empty folder.
    if (rel.endsWith("/")) {
      await mkdir(join(dir, rel), { recursive: true, mode: 0o700 });
      continue;
    }
    const path = join(dir, rel);
    if ((await readFile(path, "utf8").catch(() => undefined)) === content) continue;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, { mode: 0o600 });
    await renameOver(tmp, path);
  }
  return dir;
}

/**
 * Renames over `to`. On Windows a rename onto a file that another run is replacing or reading at the same moment
 * fails with EPERM, EACCES or EBUSY for a few milliseconds. Retry briefly, then drop the temp file.
 */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !(code === "EPERM" || code === "EACCES" || code === "EBUSY") || attempt >= 10) {
        await rm(from, { force: true });
        throw e;
      }
      await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
    }
  }
}
