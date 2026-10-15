import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const providers = fileURLToPath(new URL("../src/providers/", import.meta.url));
const driftChecks = new URL("../../../scripts/drift-checks.mjs", import.meta.url);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? sources(path) : e.name.endsWith(".ts") ? [path] : [];
  });
}

describe("drift check", () => {
  it("lists every flag the providers pass to a CLI", async () => {
    // A variable specifier keeps TypeScript from looking for types of a script outside this package.
    const { CHECKS } = (await import(driftChecks.href)) as {
      CHECKS: Record<string, { help: [string[], string[]][] }>;
    };
    const listed = new Set(Object.values(CHECKS).flatMap((c) => c.help.flatMap(([, needles]) => needles)));

    const used = new Map<string, string>();
    for (const file of sources(providers)) {
      for (const match of readFileSync(file, "utf8").matchAll(/"--[a-z][a-z-]*/g)) used.set(match[0].slice(1), file.slice(providers.length));
    }
    // Every CLI answers --version before any help text is read, and check-drift.mjs runs it first.
    used.delete("--version");

    expect(used.size).toBeGreaterThan(20);
    const unlisted = [...used].filter(([flag]) => !listed.has(flag)).map(([flag, file]) => `${flag} (${file})`);
    expect(unlisted, "Add these flags to scripts/drift-checks.mjs").toEqual([]);
  });
});
