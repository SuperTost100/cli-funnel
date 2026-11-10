# Codex provider

Runs the real `codex` binary (tested with 0.164.0, minimum 0.150.0) on your ChatGPT subscription, your API key login, or an OpenAI key passed with the run.

## How runs work

Runs use `codex app-server`, the JSON-RPC protocol over stdio, not `codex exec --json`. App-server is the only Codex interface that can pass approval requests back to the caller, interrupt a turn, and resume a thread on the same connection. Each run starts one `codex app-server` process and stops it when the turn ends. With `sessions.keepAlive` the process and thread stay up, and the next turn is another `turn/start` on the same thread. See [Live sessions](../sessions.md).

Protocol flow:

1. `initialize`, then the `initialized` notification.
2. With `apiKey`, `account/login/start`. Otherwise `account/read`, which runs alongside the next step.
3. `thread/start` (or `thread/resume` when `sessionId` is set) with model, cwd, approval policy, sandbox, approvals reviewer, `config` overrides and, for fast mode, `serviceTier: "priority"`.
4. `turn/start` with the prompt and `effort`.
5. Notifications are mapped to events. Abort sends `turn/interrupt`.

| App-server message | Funnel event |
| --- | --- |
| thread id from `thread/start` or `thread/resume` | `session` (`sessionId` is the thread id, `auth` from `account/read` or the API key) |
| `turn/plan/updated` | `plan` |
| `item/completed` for a `fileChange` | one `file.change` per changed file, then `tool.end` |
| `item/tool/requestUserInput` | `question.request`, then the answers to the server |
| `item/agentMessage/delta` | `text.delta`. This includes the short notes Codex writes between tool calls (`phase: "commentary"`). |
| `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta` | `reasoning.delta` |
| `item/started` and `item/completed` for `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `webSearch`, `imageView`, `collabAgentToolCall` | `tool.start`, `tool.end` |
| `item/started` and `item/completed` for a `subAgentActivity` with `kind: "started"` | `tool.start` named `agent:spawnAgent`, `tool.end` |
| notifications for a subagent's thread | dropped, or `tool.start`, `tool.end` and `subagent.text` with the forward options (see [Subagents](#subagents)) |
| `item/completed` for an `agentMessage` | the text becomes `result.text`, unless its `phase` is `commentary`. Commentary is streamed as `text.delta` but is not part of `result.text`. |
| `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `mcpServer/elicitation/request` | `approval.request`, then the reply to the server |
| `thread/tokenUsage/updated` | `usage` (sum of the per-call `last` breakdown, so a resumed thread reports only this turn) |
| `turn/completed` | `done` (`cancelled` when interrupted) or `error` when the turn failed |
| `error` with `willRetry: false` | `error` |
| `configWarning`, `deprecationNotice`, `warning`, `guardianWarning` | `warning` (see [Warnings](#warnings)) |

Usage has no cost figure. `inputTokens` includes cached tokens, as Codex reports them. When Codex wrote tokens to the prompt cache (`cacheWriteInputTokens`), `cacheCreationInputTokens` has their sum. Codex counts them in `inputTokens` too, as the Responses API does with `cache_write_tokens`. The field is unset when no call wrote any.

## Warnings

Four notifications become `warning` events: `configWarning` and `deprecationNotice`, which send a summary and optional details, and `warning` and `guardianWarning`, which send a message. The text is the summary followed by the details, or the message. They are not errors and the run goes on. `result.warnings` lists them in order.

Codex sends some of them before the thread starts, and a requirements fallback arrives twice, as `configWarning` and as `warning`. cli-funnel holds them until the turn's `session` event (and `access.reduced`, when there is one) has gone out, reports each text once per session, and emits later ones at once. A warning that arrives between turns of a live session comes with the next turn. When the session fails to start, the warnings come before the `error`, since they often give the reason.

## Live sessions

With `createFunnel({ sessions: { keepAlive: true } })`:

- `initialize` and `thread/start` (or `thread/resume`) run once per process. Every turn is a `turn/start` on that thread and emits its own `session` event.
- `funnel.steer(sessionId, text)` sends `turn/steer` with `expectedTurnId` set to the running turn.
- Server approval requests go to the running turn's `onApproval`. Between turns they are declined.
- An aborted turn sends `turn/interrupt` and waits for `turn/completed` (five seconds at most). When Codex acknowledged the interrupt and ended the turn, the process and thread stay live for the next turn. Otherwise the process stops. Checked live on 0.160.0: after an abort in the middle of a long answer, the next turn on the same session took 1.6 s.

## Threads, fork, usage and feedback

These calls start a short-lived `codex app-server`, make one request and stop it. They need no `keepAlive`.

| Funnel call | App-server request | Notes |
| --- | --- | --- |
| `funnel.listThreads("codex", options)` | `thread/list` | `cwd`, `search` (`searchTerm`), `limit` and `cursor` pass through. Sorted by `updated_at`, newest first. Times are Unix seconds on the wire and milliseconds in `ThreadInfo`. |
| `funnel.forkSession("codex", sessionId)` | `thread/fork` with `excludeTurns: true` | Resolves with the new thread id. Codex writes the fork to disk before it answers, and `thread/resume` opens it in a new process. An empty fork does not show in `thread/list` until it has a turn. |
| `funnel.rateLimits("codex")` | `account/rateLimits/read` | `primary` and `secondary` are the five-hour and weekly windows. `limit` uses the same rule as the `limit` event on `account/rateLimits/updated`. |
| `funnel.sendFeedback("codex", report)` | `feedback/upload` | Sends a report to OpenAI, as the TUI's `/feedback` does. Waits up to two minutes. See [Feedback reports](../feedback.md). |

An error from Codex, such as a thread that does not exist, comes back as `FunnelError` with code `cli-failed`. A call that takes longer than 30 seconds, two minutes for `feedback/upload`, fails the same way. `scripts/check-drift.mjs` checks these params and responses against the generated schema.

## Access mapping

| Access | Approval policy | Sandbox | Behavior |
| --- | --- | --- | --- |
| `none` | `untrusted` | `read-only` | Every approval is denied without calling `onApproval`. The thread starts with tool features off (`shell_tool`, `unified_exec`, `apps`, `plugins`, `multi_agent`, and more), the `view_image` feature off, web search disabled, and every MCP server in the effective config switched off by name. If Codex cannot list those servers, the run fails and no thread starts. Codex 0.166 has no switch for `apply_patch`, and none is needed: the sandbox is read-only and every approval is denied, so it cannot change a file. |
| `supervised` | `untrusted` | `workspace-write` | Every command that is not on Codex's known-safe list and every file change becomes an `approval.request`. |
| `accept-edits` | `untrusted` | `workspace-write` | File changes are allowed without asking. Commands still go to `onApproval`. |
| `auto` | `on-request` | `workspace-write` | Codex's auto review agent (`approvalsReviewer: auto_review`) decides escalations. Commands run inside the sandbox without asking. |
| `full` | `never` | `danger-full-access` | No sandbox and no prompts. With `sandbox: true`, `workspace-write` instead. With a stricter `approvalPolicy`, the requests it adds go to `onApproval`. |

`sandbox: true` changes only `full`, since the other levels already run commands in a sandbox. At `full` the thread starts with `sandbox: "workspace-write"` and approval policy `never`, so commands run without asking but can write only in `cwd` and the folders Codex's `workspace-write` defaults allow, such as the temp folder. Checked live on 0.164.0: a `full` run with `sandbox: true` could not write a file next to `cwd`, and wrote one inside it.

The `thread/start` and `thread/resume` answers say which sandbox and approval policy the thread got. A requirements file such as `/etc/codex/requirements.toml` can change both without an error, and Codex then sends a `configWarning` notification with the reason. When the sandbox is narrower than the one sent, the run emits `access.reduced` after `session` (see [Access levels](../access-levels.md#when-the-cli-starts-with-less-access)). When the policy asks less often than the level needs, the run fails with `cli-failed`.

When `onApproval` is missing, requests are denied. Denied commands are declined with `decline`, so the turn continues and the model sees the refusal. Declined commands and file changes appear in `result.deniedActions`. Verified live: an approved `echo hi > a.txt` created the file, and a declined one did not.

The `auto` level starts the thread with the auto review reviewer. A run inside the sandbox needs no review, which was verified. An escalation reviewed by the auto review agent was not exercised.

At `none` the MCP servers come from the app-server's `config/read` with the run's `cwd`. Codex parses its own config layers there, so every TOML spelling counts (quoted, dotted or escaped names, inline tables), and so do the system and project layers. Each server is switched off with `mcp_servers = { "<name>" = { enabled = false } }` in the thread config, since the dotted key `mcp_servers.<name>.enabled` cannot spell a name that contains a dot. An error from `config/read`, or an answer without an `mcp_servers` table, fails the run with `cli-failed` before `thread/start`. Checked live on 0.166.0: three servers spelled `"mcp_servers".quoted`, `"mcp_servers"."esc\u0061ped"` and `"mcp_servers"."a.b"` all started at `supervised` and none started at `none`.

Plugin and feature MCP servers are not overridden by name. Codex rejects the whole configuration when an `enabled` override names a server no config file defines, and those servers go away with their feature. Verified live on 0.159.0: with `none`, a request to create a file and run `ls` produced no tool calls and no file.

## Run options

`system` goes to `developerInstructions` on `thread/start`. Images go as `image` input items with a `data:` URL. `responseSchema` goes to `outputSchema` on `turn/start`, and the final message is the JSON. All three were verified live.

## Agent callbacks and events

The capabilities are `mcpServers: ["http", "stdio"]`, `apiKey`, `plan`, `fileChanges`, `questions` and `sandbox`. `approvalInput` is off. Each feature below was checked live on 0.164.0 with `gpt-6-luna`.

### MCP servers

`mcpServers` goes to the thread's `config` as keys under `mcp_servers.<name>`. Only the caller's names get keys, so the servers in your `config.toml` stay as they are. A name that the Codex config already declares fails the run with `invalid-selection`, because thread config would merge into that server. The names come from the app-server's `config/read`, so every config layer and TOML spelling counts.

| Field | Codex config key |
| --- | --- |
| `url` | `url` |
| `headers` | `http_headers` |
| `toolTimeoutSec` | `tool_timeout_sec` |
| `autoApprove` | `default_tools_approval_mode = "approve"` |
| `command`, `args`, `env` | `command`, `args`, `env` |

At `supervised` and `accept-edits` Codex asks before each call to a tool of the server, through `mcpServer/elicitation/request`. The request reaches `onApproval` as tool `mcp:<server>/<tool>` with the tool's arguments as `input`. The elicitation does not name the call, so cli-funnel looks for the one call in flight on the same thread and server whose arguments equal the elicitation's `_meta.tool_params`. Subagent calls count, whether or not `forwardSubagentTools` is on. When no single call matches, the request goes as tool `mcp` with the elicitation's `tool_params` as `input`, so it never shows another call's tool. With `autoApprove` Codex skips the question itself. At `full` Codex runs MCP tools without asking. Verified live at `supervised`: a local HTTP MCP server got `Authorization: Bearer ...` on every request, and the tool ran after one approval. With `autoApprove` it ran with no approval.

If you turned the `tool_call_mcp_elicitation` feature off, Codex asks the same question through `item/tool/requestUserInput` instead. Those requests go to `onApproval` too, not to `onQuestion`.

### Plans

`turn/plan/updated` becomes `{ type: "plan", steps, explanation? }`, with `inProgress` mapped to `in_progress` and `completed` to `done`. Codex 0.164 registers its `update_plan` tool only when `tools.update_plan.enabled` is set. The funnel sets it when the run passes `planTool: true`, at every level but `none`. The model then calls the tool when a task has several steps, which adds a few tool calls to such turns. Without `planTool` Codex has no plan tool and the run emits no `plan`.

Codex also has `plan` items and `item/plan/delta`. They carry the Markdown plan proposed in plan collaboration mode, not steps with a status, so they are not mapped.

### File changes

When a `fileChange` item completes, each entry of its `changes` becomes a `file.change` event: `completed` is `done`, `failed` and `declined` stay as they are. Codex sends absolute paths, and a relative one is resolved against the thread's cwd. A rename is an `update` whose `move_path` becomes `movedTo`.

Only `apply_patch` edits are reported. A file a shell command deletes or writes, such as `rm e.txt`, shows up as a `commandExecution` with a `commandActions` entry of type `unknown`. Codex has no delete action, and `turn/diff/updated` tracks patches only.

### Approval replies with a message

Codex's `decline` has no reason field. When `onApproval` returns `{ decision: "deny", message }`, the funnel first sends the message with `turn/steer` as `The user denied that action and said: <message>`, then the decline. The model reads both before its next step. Verified live: with the message "Reply only with the word PINEAPPLE." the agent answered `PINEAPPLE`.

Codex cannot change a tool's input, so an allow with `updatedInput` is sent as a decline, with its message if it has one.

### Questions

With `onQuestion`, the thread sets the `default_mode_request_user_input` feature, so the model offers its `request_user_input` tool outside plan mode. The feature is still under development, and Codex warns about that on every thread. The funnel drops that warning when the feature is the only one it lists, since the funnel switched it on. If the list names another feature, the warning is reported, because then the user's own config is involved. Each `item/tool/requestUserInput` becomes `question.request`: `isOther` becomes `allowOther` and `isSecret` becomes `secret`. Codex marks every question `isOther` and always sends options, and its tool description tells the model to ask three questions at most. There is no `multiSelect`.

A chosen option goes back as its label. Other text goes back as `user_note: <text>`, the form Codex's own TUI uses. `null` sends empty answers, and the model gets `{"answers":{}}` as the tool result, since the protocol has no separate decline. Without `onQuestion` the feature stays off, and a question the model still asks gets empty answers.

The request works without `experimentalApi`, which stays off: in 0.164 the app-server filters only experimental notifications and fields, not this request. Verified live: the model asked with three options and repeated a free-text answer.

### API key

With `apiKey` the app-server starts with `-c cli_auth_credentials_store="ephemeral"` and logs in with `account/login/start` (`type: "apiKey"`). Ephemeral credentials live in the process memory only, so `auth.json` and the keyring are never written, and the saved login is not loaded for that process. `config.toml` and the threads under `~/.codex` stay in use. The `CODEX_API_KEY` variable does not work here, because the stdio app-server ignores it. Errors are redacted with the key. Checked with a fake key: Codex used it (the API answered 401 `invalid_api_key`), and `auth.json` kept its size and mtime. The live test with a real key runs when `CLI_FUNNEL_TEST_OPENAI_KEY` is set.

`session.auth` is `api-key` for such runs. Otherwise it comes from `account/read`: `account` for a ChatGPT login and `api-key` for a saved API key login. Only the account type is read. `account/read` answers about 330 ms after `thread/start`, so the first `session` event waits for it for up to one second, while `turn/start` is already sent.

## Provider options

`providerOptions.codex` sets app-server params, not flags. `scripts/check-drift.mjs` reads them from `codex app-server generate-json-schema`.

| Option | App-server param | Access levels |
| --- | --- | --- |
| `ephemeral: boolean` | `ephemeral` on `thread/start`. Refused with `sessionId`, since `thread/resume` has no such param | all |
| `webSearch: "disabled" \| "cached" \| "indexed" \| "live"` | config `web_search` | `"disabled"` at all levels, `"cached"` and `"indexed"` from `supervised` up, `"live"` at `auto` and `full` only |
| `approvalPolicy: "untrusted" \| "on-request" \| "never"` | `approvalPolicy`, in place of the level's own | see below |
| `addDirs: string[]` | config `sandbox_workspace_write.writable_roots` | refused at `none`, accepted from `supervised` up (see below) |
| `forwardSubagentText: boolean` | none, the translator keeps the messages | all |
| `forwardSubagentTools: boolean` | none, the translator keeps the calls | all |

`approvalPolicy` may ask more often than the access level, never less. From most to fewest questions the order is `untrusted`, `on-request`, `never`. `none`, `supervised` and `accept-edits` use `untrusted`, so they accept only `untrusted`. `auto` uses `on-request` and also accepts `untrusted`. `full` accepts all three. The granular policy object is refused. At `none` every approval is still answered `deny`, whatever the policy. A policy stricter than the level's sends the requests Codex then raises to `onApproval`, as at `supervised`, and denies them when there is no handler. So `full` with `untrusted` asks before commands and file changes instead of allowing them.

All three options were run live on 0.160 at `auto`.

`addDirs` takes absolute paths and lets the `workspace-write` sandbox write to those folders as well as `cwd`. It is sent as the thread config `sandbox_workspace_write.writable_roots`, and nothing else the caller passes can change that key. A thread config replaces the list in the user's `config.toml` instead of adding to it, so when `addDirs` is set cli-funnel first reads the effective config with `config/read` and sends the user's roots followed by yours, each folder once. If that read fails, the run fails with `cli-failed` before the thread starts. `none` refuses the option, because its sandbox is read-only. At `supervised`, `accept-edits` and `auto` it adds writable roots. At `full` the sandbox is `danger-full-access`, so the option is accepted and changes nothing, and cli-funnel does not read the config. With `sandbox: true` at `full` the sandbox is `workspace-write` and the folders apply. Checked on 0.166.0 with `thread/start` and no turn: the answer listed the folder under `sandbox.writableRoots` (empty without the option), a root in `config.toml` was dropped when the thread config set the key, and a `read-only` or `danger-full-access` thread listed no roots. Whether a command can write to such a folder was not run, since that needs a model turn. Through the HTTP server each folder must sit inside `fsRoots`, as for the other providers (see [Run options](../run-options.md)).

## Subagents

Codex 0.166 starts a subagent with the `spawn_agent` tool and reports it as a `subAgentActivity` item with `kind: "started"`, the subagent's `agentThreadId` and its `agentPath`, such as `/root/list_files`. cli-funnel shows it as a `tool.start` named `agent:spawnAgent`, which ends right away because the subagent runs on its own. The `wait` call that follows is `agent:wait`. Codex before 0.166 sent a `collabAgentToolCall` with `tool: "spawnAgent"` instead, and its `receiverThreadIds` name the new threads.

The subagent works in its own thread, and the app-server sends that thread's notifications on the same connection, with the subagent's thread id. By default cli-funnel drops them, as before. The forward options keep some of them:

| What the subagent's thread sends | Default | With the option |
| --- | --- | --- |
| tool items (`commandExecution`, `fileChange`, `mcpToolCall` and the rest) | dropped | `tool.start` and `tool.end` with `parentId` and `agent`, with `forwardSubagentTools` |
| a finished `agentMessage` | dropped | `subagent.text` with `parentId` and `agent`, with `forwardSubagentText` |
| `turn/started`, `turn/completed`, usage, plans, message deltas | dropped | dropped |

`parentId` is the id of the `agent:spawnAgent` call, and `agent` is the last part of `agentPath`. A subagent's file edits produce no `file.change`, and its turn never ends the run. Its approval requests reach `onApproval` as before. `test/fixtures/codex/sub-agent-0.166.ndjson` is a recorded run on 0.166 with paths replaced. `test/fixtures/codex/sub-agent.ndjson` has the older `spawnAgent` shape.

## Models, effort and fast

`models()` runs `codex debug models` and keeps entries whose `visibility` is `list`. `id` is the slug, `name` is `display_name`, efforts come from `supported_reasoning_levels`, and `defaultEffort` from `default_reasoning_level`. If the command fails, the bundled `data/models/codex.json` is used. Effort values include `low`, `medium`, `high`, `xhigh`, and on newer models `max` and `ultra`.

`fast` is true when the model lists a `fast` speed tier or a `priority` service tier. Selecting it sends `serviceTier: "priority"`, which uses more of your usage allowance.

The context window is not selectable. The catalog reports `context_window` and `max_context_window`, but no supported setting was found for changing it, so `contextWindow` is false.

## Login, logout, update

- `authStatus()` starts a short-lived `codex app-server` and sends `account/read` (without a token refresh). A ChatGPT account gives `method: "ChatGPT"`, `account` (the email) and `plan` (the `planType`, such as `plus` or `pro`). An API key gives `method: "API key"` and nothing else. If the app-server fails, does not answer within three seconds, or reports no account or a Bedrock or GCP login, `authStatus()` parses the text of `codex login status` instead (it goes to stderr). It reads `Logged in using ChatGPT`, `Logged in using an API key` and `Not logged in`, and sets no `account` or `plan`. API keys are never echoed. `account/read` answered in about 260 ms on 0.166.0.
- `login()` runs `codex login`. It opens the browser and waits for the callback on a local port, and on a headless machine Codex switches to a device code by itself. The callback URL it prints first (`http://localhost:1455`) is skipped, so the `open-url` event carries the sign-in link. `login({ device: true })` runs `codex login --device-auth` instead: it prints a URL and a one-time code in `log` events and needs no local port, but works only after device code login is enabled in your ChatGPT security settings. Over HTTP, `POST /providers/codex/login?device=1` does the same. `codex login --with-api-key` and `--with-access-token` read from stdin and are not used.
- `logout()` runs `codex logout`. `update()` runs `codex update`. Both were implemented from `--help` and never executed during development.

## Known limits

- `item/permissions/requestApproval` and other server requests not listed above are answered with a JSON-RPC error. An `mcpServer/elicitation/request` that is not an MCP tool approval is routed as tool `mcp` and answered with accept or decline without form content.
- The user's `~/.codex/config.toml` still applies (MCP servers, instructions). Startup of configured MCP servers can add seconds and log errors on stderr.
- `accept-edits` allows all file changes, including ones outside the workspace that Codex asks to permit.
- Interrupt waits up to five seconds for the turn to finish before killing the process.
- The live tests run only with `CLI_FUNNEL_LIVE=1`.
