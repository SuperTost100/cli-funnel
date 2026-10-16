// Checks that every flag or subcommand cli-funnel depends on still shows up in the CLI's help output, and that the
// Codex app-server still takes the params providerOptions uses. The flag list is in drift-checks.mjs. Skips CLIs that
// are not installed, unless DRIFT_REQUIRE names them (comma-separated ids), in which case a missing CLI counts as a
// failure. Exits 1 when something disappeared.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKS } from "./drift-checks.mjs";

const required = (process.env.DRIFT_REQUIRE ?? "").split(",").map((s) => s.trim()).filter(Boolean);

let missing = 0;
const report = (what, where) => {
  console.log(`  MISSING ${what} in ${where}`);
  missing++;
};

/** Codex providerOptions become app-server params and config keys, not flags. Reads them from the generated schema. */
function checkCodexSchema() {
  const dir = mkdtempSync(join(tmpdir(), "cli-funnel-drift-"));
  try {
    const res = spawnSync("codex", ["app-server", "generate-json-schema", "--out", dir], { encoding: "utf8" });
    if (res.status !== 0) return report("generate-json-schema output", "codex app-server");
    const start = JSON.parse(readFileSync(join(dir, "v2", "ThreadStartParams.json"), "utf8"));
    for (const key of ["ephemeral", "approvalPolicy", "config"]) if (!start.properties?.[key]) report(key, "ThreadStartParams");
    const policies = JSON.stringify(start.definitions?.AskForApproval ?? {});
    for (const p of ["untrusted", "on-request", "never"]) if (!policies.includes(`"${p}"`)) report(`approval policy ${p}`, "AskForApproval");
    const bundle = JSON.parse(readFileSync(join(dir, "codex_app_server_protocol.v2.schemas.json"), "utf8"));
    if (!bundle.definitions?.Config?.properties?.web_search) report("web_search", "Config");
    const modes = bundle.definitions?.WebSearchMode?.enum ?? [];
    for (const m of ["disabled", "cached", "indexed", "live"]) if (!modes.includes(m)) report(`web search mode ${m}`, "WebSearchMode");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [id, { bin, help }] of Object.entries(CHECKS)) {
  const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (version.error) {
    if (required.includes(id)) {
      console.log(`${id}: MISSING, "${bin}" is not installed but DRIFT_REQUIRE lists it`);
      missing++;
    } else {
      console.log(`${id}: not installed, skipped (its flags were not checked)`);
    }
    continue;
  }
  console.log(`${id}: ${(version.stdout + version.stderr).trim().split("\n")[0]}`);
  for (const [args, needles] of help) {
    const out = spawnSync(bin, args, { encoding: "utf8" });
    const text = out.stdout + out.stderr;
    for (const needle of needles) if (!text.includes(needle)) report(needle, `"${bin} ${args.join(" ")}"`);
  }
  if (id === "codex") checkCodexSchema();
}
process.exit(missing ? 1 : 0);
