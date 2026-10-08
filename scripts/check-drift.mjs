// Checks that every flag or subcommand cli-funnel depends on still shows up in the CLI's help output.
// Skips CLIs that are not installed. Exits 1 when something disappeared.
import { spawnSync } from "node:child_process";

const CHECKS = {
  claude: { bin: "claude", help: [[["--help"], ["--output-format", "--input-format", "--include-partial-messages", "--permission-mode", "--permission-prompt-tool", "--model", "--effort", "--resume", "--verbose"]], [["auth", "--help"], ["login", "logout", "status"]]] },
  codex: { bin: "codex", help: [[["app-server", "--help"], ["generate-json-schema"]], [["login", "--help"], ["--device-auth", "status"]], [["debug", "--help"], ["models"]]] },
  agent: { bin: "agent", help: [[["--help"], ["--output-format", "--stream-partial-output", "--model", "--list-models", "--force", "--auto-review", "--mode", "--workspace", "--trust", "--resume"]]] },
  antigravity: { bin: "agy", help: [[["--help"], ["--output-format", "--model", "--effort", "--mode", "--conversation", "--dangerously-skip-permissions", "--print", "--input-format"]]] },
};

let missing = 0;
for (const [id, { bin, help }] of Object.entries(CHECKS)) {
  const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (version.error) {
    console.log(`${id}: not installed, skipped`);
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
