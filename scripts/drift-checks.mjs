// What cli-funnel needs from each CLI. For each CLI, a list of [arguments, text that must appear in the output].
// Every "--flag" string in packages/cli-funnel/src/providers must be listed here. test/drift-checks.test.ts enforces it.
export const CHECKS = {
  // Claude Code's help cannot show the stream-json fields the provider also reads: `apiKeySource` in `init`,
  // `mcp_server` in `can_use_tool`, `tool_use_result`, AskUserQuestion's `answers`, and the per-server MCP `timeout`.
  // The recorded fixtures in test/fixtures/claude and the live tests cover those.
  claude: {
    bin: "claude",
    help: [
      [["--help"], ["--output-format", "--input-format", "--include-partial-messages", "--permission-mode", "--permission-prompt-tool", "--model", "--effort", "--resume", "--verbose", "--tools", "--strict-mcp-config", "--setting-sources", "--json-schema", "--system-prompt", "--append-system-prompt", "--system-prompt[-file]", "--append-system-prompt[-file]", "--allowed-tools", "--disallowed-tools", "--add-dir", "--mcp-config", "--agents", "--fallback-model", "--max-budget-usd", "--fork-session", "--forward-subagent-text", "--betas"]],
      [["auth", "--help"], ["login", "logout", "status"]],
    ],
  },
  codex: {
    bin: "codex",
    help: [
      [["app-server", "--help"], ["generate-json-schema"]],
      [["login", "--help"], ["--device-auth", "status"]],
      [["debug", "--help"], ["models"]],
      [["mcp", "list", "--help"], ["--json"]],
    ],
  },
  agent: {
    bin: "agent",
    help: [
      [["--help"], ["--output-format", "--stream-partial-output", "--model", "--list-models", "--force", "--auto-review", "--mode", "--workspace", "--trust", "--resume", "--add-dir", "--sandbox", '"plan"']],
      [["status", "--help"], ["--format"]],
      [["about", "--help"], ["--format"]],
    ],
  },
  antigravity: {
    bin: "agy",
    help: [[["--help"], ["--output-format", "--model", "--effort", "--mode", "--conversation", "--dangerously-skip-permissions", "--print", "--input-format", "--json-schema", "path to a schema file", "--add-dir", "--print-timeout", "models"]]],
  },
};
