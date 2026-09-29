# Codex provider

Runs the real `codex` binary (tested with 0.157.0, minimum 0.150.0) on your ChatGPT subscription or API key login.

## How runs work

Runs use `codex app-server`, the JSON-RPC protocol over stdio, not `codex exec --json`. App-server is the only Codex interface that can pass approval requests back to the caller, interrupt a turn, and resume a thread on the same connection. Each run starts one `codex app-server` process and stops it when the turn ends.

Protocol flow:

1. `initialize`, then the `initialized` notification.
2. `thread/start` (or `thread/resume` when `sessionId` is set) with model, cwd, approval policy, sandbox, approvals reviewer and, for fast mode, `serviceTier: "priority"`.
3. `turn/start` with the prompt and `effort`.
4. Notifications are mapped to events. Abort sends `turn/interrupt`.

| App-server message | Funnel event |
| --- | --- |
| thread id from `thread/start` or `thread/resume` | `session` (`sessionId` is the thread id) |
| `item/agentMessage/delta` | `text.delta` |
| `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta` | `reasoning.delta` |
| `item/started` and `item/completed` for `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall` | `tool.start`, `tool.end` |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `mcpServer/elicitation/request` | `approval.request`, then the reply to the server |
| `thread/tokenUsage/updated` | `usage` (sum of the per-call `last` breakdown, so a resumed thread reports only this turn) |
| `turn/completed` | `done` (`cancelled` when interrupted) or `error` when the turn failed |
| `error` with `willRetry: false` | `error` |

Usage has no cost figure. `inputTokens` includes cached tokens, as Codex reports them.

## Access mapping

| Access | Approval policy | Sandbox | Behavior |
| --- | --- | --- | --- |
| `supervised` | `untrusted` | `workspace-write` | Every command that is not on Codex's known-safe list and every file change becomes an `approval.request`. |
| `accept-edits` | `untrusted` | `workspace-write` | File changes are allowed without asking. Commands still go to `onApproval`. |
| `auto` | `on-request` | `workspace-write` | Codex's auto review agent (`approvalsReviewer: auto_review`) decides escalations. Commands run inside the sandbox without asking. |
| `full` | `never` | `danger-full-access` | No sandbox and no prompts. |

When `onApproval` is missing, requests are denied. Denied commands are declined with `decline`, so the turn continues and the model sees the refusal. Verified live: an approved `echo hi > a.txt` created the file, and a declined one did not.

The `auto` level starts the thread with the auto review reviewer. A run inside the sandbox needs no review, which was verified. An escalation reviewed by the auto review agent was not exercised.

## Models, effort and fast

`models()` runs `codex debug models` and keeps entries whose `visibility` is `list`. `id` is the slug, `name` is `display_name`, efforts come from `supported_reasoning_levels`, and `defaultEffort` from `default_reasoning_level`. If the command fails, the bundled `data/models/codex.json` is used. Effort values include `low`, `medium`, `high`, `xhigh`, and on newer models `max` and `ultra`.

`fast` is true when the model lists a `fast` speed tier or a `priority` service tier. Selecting it sends `serviceTier: "priority"`, which uses more of your usage allowance.

The context window is not selectable. The catalog reports `context_window` and `max_context_window`, but no supported setting was found for changing it, so `contextWindow` is false.

## Login, logout, update

- `authStatus()` parses `codex login status` (the text goes to stderr). It reads `Logged in using ChatGPT`, `Logged in using an API key` and `Not logged in`. The command has no JSON or account output, so `account` and `plan` are not set. API keys are never echoed.
- `login()` runs `codex login --device-auth`, which prints a URL and a one-time code and needs no local callback port. The code appears in `log` events. The plain `codex login` opens a browser and listens on localhost, which fails on remote hosts. Device code login must be enabled in your ChatGPT security settings. `codex login --with-api-key` and `--with-access-token` read from stdin and are not used.
- `logout()` runs `codex logout`. `update()` runs `codex update`. Both were implemented from `--help` and never executed during development.

## Known limits

- `permissions/requestApproval`, `item/tool/requestUserInput` and other server requests are answered with a JSON-RPC error. `mcpServer/elicitation/request` is routed as tool `mcp` and answered with accept or decline without form content.
- The user's `~/.codex/config.toml` still applies (MCP servers, instructions). Startup of configured MCP servers can add seconds and log errors on stderr.
- `accept-edits` allows all file changes, including ones outside the workspace that Codex asks to permit.
- Interrupt waits up to five seconds for the turn to finish before killing the process.
- The live tests run only with `CLI_FUNNEL_LIVE=1`.
