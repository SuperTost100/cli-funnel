# Claude Code provider

Runs the real `claude` binary in print mode and reads its stream-json output. Tested with Claude Code 2.1.283 (supported range starts at 2.1.0). It never uses `--bare`, so your subscription login is used.

## Flags

| Purpose | Flags |
| --- | --- |
| Run | `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` |
| Prompt | One `user` JSON line on stdin. Stdin closes after the `result` message, unless the session is kept alive. |
| Model | `--model <id>`, or `--model '<id>[1m]'` for a 1M context window |
| Effort | `--effort low\|medium\|high\|xhigh\|max` |
| Access | `--permission-mode <mode>` (see below) |
| Approvals and questions | `--permission-prompt-tool stdio` |
| MCP servers | `--mcp-config=<file>`, a private temp file |
| API key | `ANTHROPIC_API_KEY` in the CLI's environment |
| Resume | `--resume <sessionId>` (same cwd as the first run) |
| Working directory | The process cwd is `selection.cwd` |
| Cancel | The abort signal sends SIGTERM |

## Stream mapping

| Claude output | FunnelEvent |
| --- | --- |
| `system` / `init` | `session` (session id, resolved model, `auth` from `apiKeySource`) |
| `text_delta` | `text.delta` |
| `thinking_delta` | `reasoning.delta` (Claude often sends empty thinking text) |
| `assistant` `tool_use` block | `tool.start`, plus `plan` for TodoWrite |
| `user` `tool_result` block | `tool.end` (`error` when `is_error`), plus `plan` for TaskCreate and TaskUpdate and `file.change` for edit tools |
| `control_request` `can_use_tool` | `approval.request`, or `question.request` for AskUserQuestion |
| `result` | `usage`, then `done` (or `error` when `is_error`) |

Usage has no `costUsd`. The CLI reports a list-price estimate, not what a subscription is charged. Subagent messages are dropped. See [Agent callbacks and events](#agent-callbacks-and-events) for `plan`, `file.change` and `question.request`.

## Access mapping

| Access | Permission mode | Approvals |
| --- | --- | --- |
| `none` | `manual`, plus `--tools ""`, `--strict-mcp-config`, `--setting-sources ""` | None. No tool exists to ask about |
| `supervised` | `manual` | Every prompt goes to `onApproval` |
| `accept-edits` | `acceptEdits` | Other prompts go to `onApproval` when it is set |
| `auto` | `auto` | Same as above |
| `full` | `bypassPermissions` | None |

Approvals work. The CLI writes a `control_request` (subtype `can_use_tool`) to stdout and waits. The provider answers on stdin with a `control_response` carrying `{behavior: "allow", updatedInput}` or `{behavior: "deny", message}`. This only happens with `--permission-prompt-tool stdio`. The `--permission-prompts host` flag alone is not enough: without the stdio tool the CLI denies the call and lists it in `permission_denials`, and `done` gets `finishReason: "denied"`. Each entry in `permission_denials` also lands in `result.deniedActions`. The help text lists `manual` as the mode name, not `default`, though `init` reports it as `default`.

## Run options

`system` goes to `--system-prompt` at `none`, which replaces Claude Code's own prompt, and to `--append-system-prompt` at the other levels. Over 4 KB the text goes to a private temp file instead (`--system-prompt-file` or `--append-system-prompt-file`), which is removed after the run, because Linux refuses one argument over 128 KiB and Windows limits the whole command line to 32,767 characters. `--json-schema` takes only inline JSON, so a very large schema can still hit that limit. Images go as `image` blocks in the stream-json user message. `responseSchema` goes to `--json-schema`, and the `result` message carries the parsed answer in `structured_output`. All three were verified live on 2.1.285. A `none` run with an image and a schema used about 1,200 input tokens.

## Agent callbacks and events

These features follow [Agent callbacks and events](../run-options.md#agent-callbacks-and-events). They were checked against Claude Code 2.1.310 with recorded fixtures in `test/fixtures/claude/` and the live runs described below. The capabilities are `mcpServers: ["http", "stdio"]`, `apiKey`, `plan`, `fileChanges`, `questions` and `approvalInput`.

### Tool prompts

`--permission-prompt-tool stdio` makes the CLI send each tool prompt to cli-funnel as a `can_use_tool` request instead of denying it. It is passed when the caller is asked about approvals (`onApproval` at `supervised`, `accept-edits` or `auto`), when `onQuestion` is set at any level but `none`, and when an HTTP server has `autoApprove` below `full`. A prompt the caller would not have been asked about before, such as a Bash command at `full` with only `onQuestion` set, is denied by cli-funnel with the CLI's own wording ("Claude requested permissions to use Bash, but you haven't granted it yet."), so those runs behave as they did. The flag also turns on AskUserQuestion, which `-p` mode leaves out otherwise. A run that only has an auto-approved server can therefore see the agent call AskUserQuestion and get it denied.

### Approval replies

A deny with `message` goes to the CLI as `{behavior: "deny", message}`, and the model reads it as the tool's error. Live check: a `supervised` run denied `touch marker.txt` with "Blocked by policy ZEBRA-42: list files through the app instead.", and the answer quoted that text word for word. `updatedInput` on an allow replaces the tool input.

### MCP servers

`mcpServers` is written to a private temp file (mode 0600) and passed as `--mcp-config=<file>`, because headers and env often carry tokens that argv would show to other users of the machine. The file is removed after the run, or after the first turn of a live session. Each server becomes `{type: "http", url, headers, timeout}` or `{type: "stdio", command, args, env, timeout}`. It is merged with `providerOptions.claude.mcpConfig`, which stays `full` only, and a name in both fails the run with `invalid-selection`. A server with the same name as one in the user's own config replaces it for the run.

`toolTimeoutSec` becomes the server's `timeout` in milliseconds. Claude Code 2.1.310 reads it per server and prefers it over the `MCP_TOOL_TIMEOUT` environment variable. It also raises the idle timeout of HTTP servers (5 minutes by default) to the same value. Live check: a server whose tool waits 8 seconds, with `toolTimeoutSec: 3`, failed with `MCP server "cftest" tool "slow_echo" timed out after 3s`.

`autoApprove` allows that server's tool calls without `onApproval`. The `can_use_tool` request names the server as configured (`mcp_server: {name, source}`), and cli-funnel allows the call only when the name is one of the caller's auto-approved servers and the source is `dynamic`, which means `--mcp-config`. It does not use `--allowed-tools=mcp__<name>`: tool names are normalized, so that rule also matched the tools of the claude.ai connector "claude.ai Claude Docs" when the caller named a server `claude_ai_Claude_Docs`. Live check: a `supervised` run whose `onApproval` denied everything called a tool on a local HTTP MCP server with an `Authorization` header. The tool ran with no approval asked, and the server logged the header on every request.

### Plans

Claude Code 2.1.310 picks the plan tool by model. Claude 4.x and older models (Haiku 4.5, Sonnet 4.6, Opus 4.7 and earlier) get TaskCreate and TaskUpdate. With `CLAUDE_CODE_ENABLE_TASKS=false` they get TodoWrite instead. Newer models (Sonnet 5, Opus 5.5) get no plan tool unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set, so their runs emit no `plan` events.

- TodoWrite sends the whole list, which becomes a `plan` right after its `tool.start`.
- TaskCreate and TaskUpdate change one task at a time. cli-funnel keeps the list for the life of the process and emits the whole plan after each successful result. `deleted` removes a task. A resumed session starts with an empty list, so updates to tasks created in earlier runs are ignored.

Statuses map `pending` to `pending`, `in_progress` to `in_progress` and `completed` to `done`.

### File changes

Write, Edit, MultiEdit and NotebookEdit produce one `file.change` each, with the path made absolute against `cwd`. The kind comes from Write's own result (`create` or `update`) when it has one. Otherwise it comes from whether the file existed when cli-funnel saw the `tool.start`.

| Tool result | Status | When it is emitted |
| --- | --- | --- |
| Success | `done` | With the tool result |
| Denied through `onApproval`, or by cli-funnel | `declined` | With the tool result |
| Error, and listed in the result's `permission_denials` | `declined` | At the end of the turn, before `done` |
| Other error | `failed` | At the end of the turn, before `done` |

Not covered: shell commands (a file deleted or moved with Bash produces no `file.change`, since Claude Code reports only the command), and edits made by subagents, whose tool calls the CLI does not forward.

### Questions

With `onQuestion`, a `can_use_tool` request for AskUserQuestion becomes `question.request` with the tool use id as its id. Question ids are positions (`"0"`, `"1"`, ...). Options keep their label and description, `multiSelect` is copied, and `allowOther` is always true because Claude Code always offers "Other". The answers go back as an allow whose `updatedInput` adds `answers` keyed by question text, with several answers joined by ", ", the shape AskUserQuestion reads. A label that contains ", " cannot be told apart after the join. A `null` reply denies the call with "The user did not answer." Without `onQuestion`, AskUserQuestion is a tool approval as before.

The CLI sends the request at every level with tools: it was checked live at `bypassPermissions`, `acceptEdits` and `default`. A live run at `full` answered with the free text "Teal, like the sea", and the model replied with it.

### API key

`apiKey` is set as `ANTHROPIC_API_KEY` in the CLI's environment, over any value in `env`. It never goes in argv. In `-p` mode Claude Code 2.1.310 takes the key from the environment before the saved login and needs no approval of the key (the approval prompt for a new key is only in interactive mode), and it turns off the claude.ai login for that process. The saved login is not touched. `session.auth` comes from `apiKeySource` in `init`: `none` is `account`, and `ANTHROPIC_API_KEY`, `apiKeyHelper` and `/login managed key` are `api-key`. Live check with an invalid key: `init` reported `apiKeySource: "ANTHROPIC_API_KEY"` and the run failed with a 401 "Invalid API key", so the subscription was not used. A live test with a real key runs when `CLI_FUNNEL_TEST_ANTHROPIC_KEY` is set.

## Provider options

`providerOptions.claude` maps to flags checked against 2.1.300. Every value goes in `--flag=value` form, one flag per list item, so a value that starts with a dash is never read as a flag.

| Option | Flag | Access levels |
| --- | --- | --- |
| `allowedTools: string[]` | `--allowed-tools=<tool>` | `full` only |
| `disallowedTools: string[]` | `--disallowed-tools=<tool>` | all |
| `addDirs: string[]` | `--add-dir=<dir>`, absolute paths | all but `none` |
| `mcpConfig: object` | `--mcp-config=<json>` | `full` only |
| `agents: Record<string, ClaudeAgent>` | `--agents=<json>` | all but `none` |
| `fallbackModel: string` | `--fallback-model=<ids>` | all |
| `maxBudgetUsd: number` | `--max-budget-usd=<n>` | all |
| `forkSession: boolean` | `--fork-session`, needs `sessionId` | all |
| `forwardSubagentText: boolean` | `--forward-subagent-text` | all |
| `betas: string[]` | `--betas=<header>` | all |

`forkSession` works on live sessions: the fork gets its own process and the parent's stays up. See [Live sessions](../sessions.md#fork-a-session).

`forwardSubagentText` makes Claude Code send the subagents' messages with `parent_tool_use_id` set to the id of the `Agent` call. cli-funnel turns each text block into a `subagent.text` event with that id as `parentId`. Without the flag, the CLI sends only the subagent's prompt, as a `user` message with `parent_tool_use_id` (checked on 2.1.300), and the parser drops it. With it, a subagent's `assistant` message arrives whole, not as stream deltas, and its thinking block is empty. The parser ignores the subagent's prompt, thinking and tool calls. `test/fixtures/claude/subagent-text.ndjson` is a recorded run, with ids replaced.

`mcpConfig` and `agents` take objects, not file paths. A subagent may set `description`, `prompt`, `tools`, `disallowedTools` and `model`. `maxBudgetUsd` compares against the CLI's list-price estimate, which is not what a subscription pays. `betas` only matters for API key logins. See [Run options](../run-options.md#provider-options) for why each limit is where it is.

## Models

Claude has no list command, so models come from `data/models/claude.json`.

| Id | Efforts | Notes |
| --- | --- | --- |
| `claude-fable-5-1` | low to max | Needs usage credits on a Pro plan (the run returns a 429 error) |
| `claude-opus-5-5` | low to max | 1M context |
| `claude-sonnet-5` | low to max | 1M context |
| `claude-opus-4-6` | low, medium, high, max | 200k context, or 1M with `contextWindow: 1000000` |
| `claude-haiku-4-5-20251001` | none listed | 200k context |

Each id was run with `claude -p` and `init` reported the same id back, except Fable, which resolves but is then refused for credits. Aliases such as `opus` are not listed.

Effort: the CLI accepts `--effort` values `low`, `medium`, `high`, `xhigh` and `max` for every model tried, and only warns on unknown values. It gives no per-model list, so per-model support is not checked. Haiku accepts the flag but no effort is offered for it. No default effort is set, so the CLI decides.

Context: Claude Code picks a model's 1M context variant through a `[1m]` suffix on the model id. A selection with `contextWindow: 1000000` on a model that lists `[200000, 1000000]` in `contextWindows` runs with `--model '<id>[1m]'`, and the `session` event reports the suffixed id. Without `contextWindow`, or with the default, the id goes unchanged.

Tested on 2.1.300 with `modelUsage.contextWindow` from the result:

- `claude-opus-4-6` reports 200,000, and `claude-opus-4-6[1m]` reports 1,000,000.
- Sonnet 5, Opus 5.5 and Fable 5.1 already report 1,000,000 without the suffix, so they list no context sizes.
- `claude-sonnet-4-6[1m]` failed with "Usage credits required for 1M context", and `claude-haiku-4-5-20251001[1m]` with "The long context beta is not yet available for this subscription". Neither is offered. Other plans may differ.

## Fast mode

Not supported. `fastMode` is a Claude Code setting, but in SDK-style runs the CLI reports `fast_mode_disabled_reason: "sdk_opt_in_required"` and it needs extra usage enabled on the account. It was not confirmed to work headlessly, so `fast` is false.

## Login, logout, update

- `login()` runs `claude auth login` (subscription login). It opens a browser page. If the CLI asks for a pasted code, use `sendCode`. Options such as `--console`, `--sso` and `--email` are not exposed.
- `logout()` runs `claude auth logout`.
- `update()` runs `claude update`.
- `authStatus()` reads `claude auth status`. The org id is not returned. Login, logout and update were not run during development, to protect the local install.

## Live sessions

With `createFunnel({ sessions: { keepAlive: true } })` stdin stays open after `result`, and the next turn writes another `user` line to the same process. Claude Code sends a new `system` / `init` message for each turn, with the same session id. Closing an idle session closes stdin and gives Claude Code two seconds to exit on its own.

There is no `steer`. A `user` line written while a turn runs does not join that turn: Claude Code answers it afterwards as a turn of its own, with a second `result`. See [Live sessions](../sessions.md).

## Known limits

- Fast mode is unavailable.
- Approval requests other than `can_use_tool` are answered with an error.
- Sonnet 5 and Opus 5.5 have no plan tool by default, so they emit no `plan`.
- Shell commands and subagents produce no `file.change`.
- Resume needs the same cwd as the original run, because Claude stores sessions per project directory.
- The `paste` and other MCP servers that need auth print a note in the model's reply, not an error.
