import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/package-readme.mjs", import.meta.url));

function convert(markdown: string, env: Record<string, string> = {}, ref?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-readme-"));
  writeFileSync(join(dir, "in.md"), markdown);
  // Windows reads environment names in any case, so the value npm set for this package could win over the override.
  // Drop every name the override sets, in any case, before adding it.
  const names = new Set(Object.keys(env).map((k) => k.toLowerCase()));
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !names.has(k.toLowerCase())));
  execFileSync(process.execPath, [script, join(dir, "in.md"), join(dir, "out.md"), ...(ref ? [ref] : [])], { env: { ...base, ...env } });
  return readFileSync(join(dir, "out.md"), "utf8");
}

describe("package-readme", () => {
  it("turns repository links into GitHub URLs pinned to the tag", () => {
    const out = convert(
      [
        '<img src="docs/assets/icon.svg" alt="">',
        '<source srcset="docs/a-dark.png 1x, docs/a-dark@2x.png 2x">',
        '<a href="LICENSE">MIT</a> <a href="#install">Install</a>',
        "[Quickstart](docs/quickstart.md) ![shot](docs/shot.png)",
        "[npm](https://www.npmjs.com/package/cli-funnel) <img src=\"https://img.shields.io/x\">",
      ].join("\n"),
      {},
      "v1.2.3",
    );
    const raw = "https://raw.githubusercontent.com/SuperTost100/cli-funnel/v1.2.3/";
    const blob = "https://github.com/SuperTost100/cli-funnel/blob/v1.2.3/";
    expect(out).toContain(`src="${raw}docs/assets/icon.svg"`);
    expect(out).toContain(`srcset="${raw}docs/a-dark.png 1x, ${raw}docs/a-dark@2x.png 2x"`);
    expect(out).toContain(`href="${blob}LICENSE"`);
    expect(out).toContain('href="#install"');
    expect(out).toContain(`[Quickstart](${blob}docs/quickstart.md)`);
    expect(out).toContain(`![shot](${raw}docs/shot.png)`);
    expect(out).toContain("[npm](https://www.npmjs.com/package/cli-funnel)");
    expect(out).toContain('src="https://img.shields.io/x"');
  });

  it("takes the tag from the version npm passes to the pack script", () => {
    expect(convert("[a](docs/a.md)", { npm_package_version: "0.5.1" })).toBe("[a](https://github.com/SuperTost100/cli-funnel/blob/v0.5.1/docs/a.md)");
  });
});
