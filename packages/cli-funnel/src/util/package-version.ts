import { readFileSync } from "node:fs";

/** This package's version. Source files sit three levels below the package root, bundled files one or two. */
export function packageVersion(): string | undefined {
  for (const rel of ["../../../package.json", "../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
      if (pkg.name === "cli-funnel") return pkg.version;
    } catch {
      /* not at this level */
    }
  }
  return undefined;
}
