import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Points os.tmpdir() at one folder per test run and removes it afterwards, so test folders do not pile up in /tmp. */
export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cli-funnel-test-"));
  process.env.TMPDIR = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}
