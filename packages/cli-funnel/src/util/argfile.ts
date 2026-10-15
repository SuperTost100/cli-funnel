import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Text over this many bytes goes to a file instead of argv. Linux refuses one argument over 128 KiB, and Windows
 * limits the whole command line to 32,767 characters, so the cut-off sits far below both.
 */
export const ARG_FILE_OVER = 4_096;

export function needsArgFile(text: string): boolean {
  return Buffer.byteLength(text) > ARG_FILE_OVER;
}

export interface ArgFile {
  path: string;
  /** Removes the file and its folder. Safe to call twice. */
  remove(): Promise<void>;
}

/** Writes `content` to a file in a new folder only the current user can open (mode 0700, file 0600). */
export async function writeArgFile(name: string, content: string): Promise<ArgFile> {
  const dir = await mkdtemp(join(tmpdir(), "cli-funnel-"));
  try {
    const path = join(dir, name);
    await writeFile(path, content, { mode: 0o600 });
    return { path, remove: () => rm(dir, { recursive: true, force: true }) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}
