import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Root for folders cli-funnel owns. Lives under the user's cache dir, never in a shared temp dir. */
export function funnelCacheDir(): string {
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
    await rename(tmp, path);
  }
  return dir;
}
