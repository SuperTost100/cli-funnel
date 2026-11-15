import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

/**
 * `cwd` and every folder above it, both as given and with symlinks resolved, so a trust entry for any of them is
 * overridden whichever spelling Codex compares against.
 */
export function folderChain(cwd: string): string[] {
  const out = new Set<string>();
  for (const start of existsSync(cwd) ? [cwd, realpathSync(cwd)] : [cwd]) {
    for (let dir = start; ; dir = dirname(dir)) {
      out.add(dir);
      if (dirname(dir) === dir) break;
    }
  }
  return [...out];
}

/** The paths of the skills `skills/list` found in the folder and the folders above it up to the project root. */
export function repoSkillPaths(res: unknown): string[] {
  const data = (res as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("skills/list returned no data.");
  return data.flatMap((entry: { skills?: { scope?: unknown; path?: unknown }[] }) =>
    (entry.skills ?? []).flatMap((s) => (s.scope === "repo" && typeof s.path === "string" ? [s.path] : [])),
  );
}

/** The `skills.config` list of the user's own config layers, from `config/read` without a `cwd`. */
export function userSkillRules(res: unknown): unknown[] {
  const rules = (res as { config?: { skills?: { config?: unknown } } } | null)?.config?.skills?.config;
  return Array.isArray(rules) ? rules : [];
}

/**
 * Thread config for `folderConfig: "ignore"`. Checked on 0.166:
 *
 * - An `untrusted` entry for each folder from `cwd` up skips every project `.codex/` layer: its `config.toml` (MCP
 *   servers, model settings), hooks and `rules/` (whose `allow` rules run commands without an approval). A thread
 *   started without it adds a `trusted` entry for the project root to the user's `config.toml`. With it, nothing is
 *   written.
 * - `project_doc_max_bytes = 0` leaves out the folder's `AGENTS.md`. Untrusted folders already left it out on 0.166,
 *   so this keeps it out if a later version loads it anyway. The user's own `AGENTS.md` still loads.
 * - The folder's skills (`.agents/skills`) load whatever the trust, so each one is switched off by path. A thread
 *   config list replaces the user's, so the user's own rules go first.
 */
export function ignoreFolderConfig(cwd: string, skillPaths: string[], userSkills: unknown[]): Record<string, unknown> {
  return {
    projects: Object.fromEntries(folderChain(cwd).map((dir) => [dir, { trust_level: "untrusted" }])),
    project_doc_max_bytes: 0,
    ...(skillPaths.length ? { skills: { config: [...userSkills, ...skillPaths.map((path) => ({ path, enabled: false }))] } } : {}),
  };
}
