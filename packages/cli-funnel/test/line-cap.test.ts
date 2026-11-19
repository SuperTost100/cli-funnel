import { describe, expect, it } from "vitest";
import { MAX_STDOUT_LINE, spawnStream } from "../src/util/process.js";

describe.skipIf(process.platform === "win32")("an unfinished stdout line", () => {
  it("ends the run with an error and stops the process when it passes the cap", async () => {
    // 3 MB with no line break, and a process that would go on printing.
    const proc = spawnStream(process.execPath, ["-e", "process.stdout.write('x'.repeat(3e6)); setInterval(() => process.stdout.write('y'.repeat(1e5)), 10)"], { maxLineChars: 1_000_000 });
    const read = async () => {
      for await (const _ of proc.lines) {
        /* drain */
      }
    };
    await expect(read()).rejects.toMatchObject({ code: "cli-failed", message: expect.stringContaining("1000000") });
    // The process is stopped, not left running.
    expect(await proc.exited).not.toBe(0);
  }, 20_000);

  it("also stops on a long line that arrives in one chunk with its own line break, and emits nothing from it", async () => {
    const proc = spawnStream(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ ok: 1 }) + '\\n' + 'x'.repeat(5000) + '\\n' + JSON.stringify({ after: 1 }) + '\\n')"], { maxLineChars: 1000 });
    const seen: unknown[] = [];
    const read = async () => {
      for await (const line of proc.lines) seen.push(line);
    };
    await expect(read()).rejects.toMatchObject({ code: "cli-failed" });
    // The short line before it was real output. The long one and what follows it are not emitted.
    expect(seen).toEqual([{ ok: 1 }]);
  }, 20_000);

  it("keeps lines under the cap, however many there are", async () => {
    const proc = spawnStream(process.execPath, ["-e", "for (let i = 0; i < 2000; i++) console.log(JSON.stringify({ i, pad: 'p'.repeat(1000) }))"], { maxLineChars: 100_000 });
    let n = 0;
    for await (const _ of proc.lines) n++;
    expect(n).toBe(2000);
  });

  it("has a cap that fits a large stream-json result", () => {
    expect(MAX_STDOUT_LINE).toBeGreaterThanOrEqual(32 * 1024 * 1024);
  });
});
