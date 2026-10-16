# Codex provider

Runs the real `codex` binary (tested with 0.157.0, minimum 0.150.0) on your ChatGPT subscription or API key login.

## How runs work

Runs use `codex app-server`, the JSON-RPC protocol over stdio, not `codex exec --json`. App-server is the only Codex interface that can pass approval requests back to the caller, interrupt a turn, and resume a thread on the same connection. Each run starts one `codex app-server` process and stops it when the turn ends. With `sessions.keepAlive` the process and thread stay up, and the next turn is another `turn/start` on the same thread. See [Live sessions](../sessions.md).

Protocol flow:

1. `initialize`, then the `initialized` notification.
2. `thread/start` (or `thread/resume` when `sessionId` is set) with model, cwd, approval policy, sandbox, approvals reviewer and, for fast mode, `serviceTier: "priority"`.
3. `turn/start` with the prompt and `effort`.
4. Notifications are mapped to events. Abort sends `turn/interrupt`.

| App-server message | Funnel event |
| --- | --- |
| thread id from `thread/start` or `thread/resume` | `session` (`sessionId` is the thread id) |
| `item/agentMessage/delta` | `text.delta`, or `reasoning.delta` when the message's `phase` (from `item/started`) is `commentary` |
| `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta` | `reasoning.delta` |
| `item/started` and `item/completed` for `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `webSearch`, `imageView`, `collabAgentToolCall` | `tool.start`, `tool.end` |
| `item/completed` for an `agentMessage` | the text joins the answer unless its `phase` is `commentary` |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `mcpServer/elicitation/request` | `approval.request`, then the reply to the server |
| `thread/tokenUsage/updated` | `usage` (sum of the per-call `last` breakdown, so a resumed thread reports only this turn) |
| `turn/completed` | `done` (`cancelled` when interrupted) or `error` when the turn failed |
| `error` with `willRetry: false` | `error` |

Usage has no cost figure. `inputTokens` includes cached tokens, as Codex reports them.

## Live sessions

With `createFunnel({ sessions: { keepAlive: true } })`:

- `initialize` and `thread/start` (or `thread/resume`) run once per process. Every turn is a `turn/start` on that thread and emits its own `session` event.
- `funnel.steer(sessionId, text)` sends `turn/steer` with `expectedTurnId` set to the running turn.
- Server approval requests go to the running turn's `onApproval`. Between turns they are declined.
- An aborted turn sends `turn/interrupt` and waits for `turn/completed` (five seconds at most). When Codex acknowledged the interrupt and ended the turn, the process and thread stay live for the next turn. Otherwise the process stops. Checked live on 0.160.0: after an abort in the middle of a long answer, the next turn on the same session took 1.6 s.

## Threads, fork and usage

These calls start a short-lived `codex app-server`, make one request and stop it. They need no `keepAlive`.

| Funnel call | App-server request | Notes |
| --- | --- | --- |
| `funnel.listThreads("codex", options)` | `thread/list` | `cwd`, `search` (`searchTerm`), `limit` and `cursor` pass through. Sorted by `updated_at`, newest first. Times are Unix seconds on the wire and milliseconds in `ThreadInfo`. |
| `funnel.forkSession("codex", sessionId)` | `thread/fork` with `excludeTurns: true` | Resolves with the new thread id. Codex writes the fork to disk before it answers, and `thread/resume` opens it in a new process. An empty fork does not show in `thread/list` until it has a turn. |
| `funnel.rateLimits("codex")` | `account/rateLimits/read` | `primary` and `secondary` are the five-hour and weekly windows. `limit` uses the same rule as the `limit` event on `account/rateLimits/updated`. |

An error from Codex, such as a thread that does not exist, comes back as `FunnelError` with code `cli-failed`. A call that takes longer than 30 seconds fails the same way. `scripts/check-drift.mjs` checks these params and responses against the generated schema.

## Access mapping

| Access | Approval policy | Sandbox | Behavior |
| --- | --- | --- | --- |
| `none` | `untrusted` | `read-only` | Every approval is denied without calling `onApproval`. The thread starts with tool features off (`shell_tool`, `unified_exec`, `apps`, `plugins`, `multi_agent`, and more), web search disabled, and every enabled MCP server from the user's or project's `config.toml` switched off by name. |
| `supervised` | `untrusted` | `workspace-write` | Every command that is not on Codex's known-safe list and every file change becomes an `approval.request`. |
| `accept-edits` | `untrusted` | `workspace-write` | File changes are allowed without asking. Commands still go to `onApproval`. |
| `auto` | `on-request` | `workspace-write` | Codex's auto review agent (`approvalsReviewer: auto_review`) decides escalations. Commands run inside the sandbox without asking. |
| `full` | `never` | `danger-full-access` | No sandbox and no prompts. |

When `onApproval` is missing, requests are denied. Denied commands are declined with `decline`, so the turn continues and the model sees the refusal. Declined commands and file changes appear in `result.deniedActions`. Verified live: an approved `echo hi > a.txt` created the file, and a declined one did not.

The `auto` level starts the thread with the auto review reviewer. A run inside the sandbox needs no review, which was verified. An escalation reviewed by the auto review agent was not exercised.

Plugin and feature MCP servers are not overridden by name. Codex rejects the whole configuration when `mcp_servers.<name>.enabled` names a server no config file defines, and those servers go away with their feature. Verified live on 0.159.0: with `none`, a request to create a file and run `ls` produced no tool calls and no file.

## Run options

`system` goes to `developerInstructions` on `thread/start`. Images go as `image` input items with a `data:` URL. `responseSchema` goes to `outputSchema` on `turn/start`, and the final message is the JSON. All three were verified live.

## Provider options

`providerOptions.codex` sets app-server params, not flags. `scripts/check-drift.mjs` reads them from `codex app-server generate-json-schema`.

| Option | App-server param | Access levels |
| --- | --- | --- |
| `ephemeral: boolean` | `ephemeral` on `thread/start`. Refused with `sessionId`, since `thread/resume` has no such param | all |
| `webSearch: "disabled" \| "cached" \| "indexed" \| "live"` | config `web_search` | `"disabled"` at all levels, `"cached"` and `"indexed"` from `supervised` up, `"live"` at `auto` and `full` only |
| `approvalPolicy: "untrusted" \| "on-request" \| "never"` | `approvalPolicy`, in place of the level's own | see below |

`approvalPolicy` may ask more often than the access level, never less. From most to fewest questions the order is `untrusted`, `on-request`, `never`. `none`, `supervised` and `accept-edits` use `untrusted`, so they accept only `untrusted`. `auto` uses `on-request` and also accepts `untrusted`. `full` accepts all three. The granular policy object is refused. At `none` every approval is still answered `deny`, whatever the policy.

All three options were run live on 0.160 at `auto`.

## Models, effort and fast

`models()` runs `codex debug models` and keeps entries whose `visibility` is `list`. `id` is the slug, `name` is `display_name`, efforts come from `supported_reasoning_levels`, and `defaultEffort` from `default_reasoning_level`. If the command fails, the bundled `data/models/codex.json` is used. Effort values include `low`, `medium`, `high`, `xhigh`, and on newer models `max` and `ultra`.

`fast` is true when the model lists a `fast` speed tier or a `priority` service tier. Selecting it sends `serviceTier: "priority"`, which uses more of your usage allowance.

The context window is not selectable. The catalog reports `context_window` and `max_context_window`, but no supported setting was found for changing it, so `contextWindow` is false.

## Login, logout, update

- `authStatus()` parses `codex login status` (the text goes to stderr). It reads `Logged in using ChatGPT`, `Logged in using an API key` and `Not logged in`. The command has no JSON or account output, so `account` and `plan` are not set. API keys are never echoed.
- `login()` runs `codex login`. It opens the browser and waits for the callback on a local port, and on a headless machine Codex switches to a device code by itself. The callback URL it prints first (`http://localhost:1455`) is skipped, so the `open-url` event carries the sign-in link. `login({ device: true })` runs `codex login --device-auth` instead: it prints a URL and a one-time code in `log` events and needs no local port, but works only after device code login is enabled in your ChatGPT security settings. Over HTTP, `POST /providers/codex/login?device=1` does the same. `codex login --with-api-key` and `--with-access-token` read from stdin and are not used.
- `logout()` runs `codex logout`. `update()` runs `codex update`. Both were implemented from `--help` and never executed during development.

## Known limits

- `permissions/requestApproval`, `item/tool/requestUserInput` and other server requests are answered with a JSON-RPC error. `mcpServer/elicitation/request` is routed as tool `mcp` and answered with accept or decline without form content.
- The user's `~/.codex/config.toml` still applies (MCP servers, instructions). Startup of configured MCP servers can add seconds and log errors on stderr.
- `accept-edits` allows all file changes, including ones outside the workspace that Codex asks to permit.
- Interrupt waits up to five seconds for the turn to finish before killing the process.
- The live tests run only with `CLI_FUNNEL_LIVE=1`.
