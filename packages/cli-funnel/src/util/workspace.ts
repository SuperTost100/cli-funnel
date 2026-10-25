import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Root for folders cli-funnel owns. Lives under the user's cache dir, never in a shared temp dir. */
function funnelCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "cli-funnel");
}

/**
 * Returns a private folder that holds only `files`, for runs that must not see the user's project.
 * Files are rewritten when their content differs, through a rename so a concurrent run never reads half a file.
 */
export async function ownedWorkspace(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(funnelCacheDir(), "workspaces", name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [rel, content] of Object.entries(files)) {
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
