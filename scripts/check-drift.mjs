// Checks that every flag or subcommand cli-funnel depends on still shows up in the CLI's help output.
// The list is in drift-checks.mjs. Skips CLIs that are not installed, unless DRIFT_REQUIRE names them
// (comma-separated ids), in which case a missing CLI counts as a failure. Exits 1 when something disappeared.
import { spawnSync } from "node:child_process";
import { CHECKS } from "./drift-checks.mjs";

const required = (process.env.DRIFT_REQUIRE ?? "").split(",").map((s) => s.trim()).filter(Boolean);

let missing = 0;
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
    for (const needle of needles) {
      if (!text.includes(needle)) {
        console.log(`  MISSING ${needle} in "${bin} ${args.join(" ")}"`);
        missing++;
      }
    }
  }
}
process.exit(missing ? 1 : 0);
