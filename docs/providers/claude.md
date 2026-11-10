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
| `system` / `notification` with priority `high` or `immediate` | `warning` |
| A stderr line that starts with `Warning:` or `⚠` | `warning` |

`usage` carries `cacheCreationInputTokens` (from `cache_creation_input_tokens`) and `reasoningTokens` (from `output_tokens_details.thinking_tokens`) when they are above zero. The CLI's `input_tokens` leaves out cache reads and writes, so `inputTokens` is the sum of all three, and `outputTokens` already includes the thinking tokens. Usage has no `costUsd`. The CLI reports a list-price estimate, not what a subscription is charged. Subagent messages are dropped. See [Agent callbacks and events](#agent-callbacks-and-events) for `plan`, `file.change` and `question.request`.

### Warnings

Claude Code reports notices in two places, and both become `warning` events, which also fill `RunResult.warnings`.

- **Stderr.** A line that starts with `Warning:` or `⚠`, followed by a space, starts a warning, and the message is the text after the marker. Lines right after it that start with whitespace belong to it, joined with one space. Examples from 2.1.319 are an unknown `--effort` value that the CLI ignores, the claude.ai connectors that an API key turns off, and a sandbox that cannot start because `bubblewrap` or `socat` is missing (a two-line notice). Lines that start with `Error:` are not warnings: they go into the error of a failed run. Every other line is ignored, unless the run is verbose, which sends all of stderr as `raw` events. The CLI prints these before `init` and keeps running.
- **Stream.** A `system` message with `subtype: "notification"` and `priority` of `high` or `immediate` becomes a warning with its `text`, for example "Fast mode disabled · usage credit limit reached". `low` and `medium` notices are hints and are left out.

Stderr is a separate pipe from stdout, so warnings from stderr and from the stream are held until the turn's `session` event (and `access.reduced`) have been sent, and come right after. A warning that arrives later comes after the next line the CLI prints. The last warning is held for 50 ms after its last line, because a continuation line may still come. It then goes out with the next line the CLI prints, or at the latest just before `done` or `error`. A run that ends without a `session` event sends all of them just before its last event. Nothing follows `done` or `error`. The run's API key and other secrets are masked in the text. In a live session the process outlives the turn: warnings from startup belong to the first turn, a warning that arrives between two turns is dropped, and each warning is reported once.

## Access mapping

| Access | Permission mode | Approvals |
| --- | --- | --- |
| `none` | `manual`, plus `--tools ""`, `--strict-mcp-config`, `--setting-sources ""` | None. No tool exists to ask about |
| `supervised` | `manual` | Every prompt goes to `onApproval` |
| `accept-edits` | `acceptEdits` | Other prompts go to `onApproval` when it is set |
| `auto` | `auto` | Same as above |
| `full` | `bypassPermissions` | None |

Approvals work. The CLI writes a `control_request` (subtype `can_use_tool`) to stdout and waits. The provider answers on stdin with a `control_response` carrying `{behavior: "allow", updatedInput}` or `{behavior: "deny", message}`. This only happens with `--permission-prompt-tool stdio`. The `--permission-prompts host` flag alone is not enough: without the stdio tool the CLI denies the call and lists it in `permission_denials`, and `done` gets `finishReason: "denied"`. Each entry in `permission_denials` also lands in `result.deniedActions`. The help text lists `manual` as the mode name, not `default`, though `init` reports it as `default`.

`init` reports the mode the CLI started in as `permissionMode`. Managed settings that switch a mode off, or a model without auto mode, leave it in `default` without an error. At `accept-edits`, `auto` and `full` the run then emits `access.reduced` after `session`, with the mode names as `init` prints them, such as `expected: "bypassPermissions"` and `started: "default"`. See [Access levels](../access-levels.md#when-the-cli-starts-with-less-access).

### Sandbox

`sandbox: true` passes `--settings` with `{"sandbox": {"enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false, "autoAllowBashIfSandboxed": false}}` at every level but `none`, where no tool exists. Bash commands then run in Claude Code's sandbox, which lets them write in `cwd`, the `addDirs` folders and the CLI's own temp folder. The other settings do this:

- `failIfUnavailable` stops the CLI at startup when the sandbox cannot start. Without it Claude Code shows a warning and runs commands unconfined. The run fails with an error that carries the CLI's reason from stderr.
- `allowUnsandboxedCommands: false` makes the CLI ignore the `dangerouslyDisableSandbox` parameter, so the model cannot ask to run a command outside.
- `autoAllowBashIfSandboxed: false` keeps every command going through the level's approvals. At `supervised` each one still reaches `onApproval`.

Checked on 2.1.310. A `supervised` run whose `onApproval` allowed every command could not write `../outside.txt` ("Read-only file system"), while writes inside `cwd` and an `addDirs` folder worked. The same command was refused at `full` (`bypassPermissions`) too. The live test is in `test/sandbox-live.test.ts`.

The sandbox covers Bash only. Write and Edit follow the access level: at `full` the Write tool created a file outside `cwd` with the sandbox on. The user's own settings still apply, so their `sandbox.excludedCommands` run outside the sandbox (after the level's approvals) and their `sandbox.filesystem.allowWrite` paths stay writable.

On Linux the sandbox needs `bubblewrap` and `socat`. Ubuntu 24.04 blocks bubblewrap from creating user namespaces, and the run then fails with "sandbox required but unavailable" until an AppArmor profile for `/usr/bin/bwrap` allows `userns`.

## Run options

`system` goes to `--system-prompt` at `none`, which replaces Claude Code's own prompt, and to `--append-system-prompt` at the other levels. Over 4 KB the text goes to a private temp file instead (`--system-prompt-file` or `--append-system-prompt-file`), which is removed after the run, because Linux refuses one argument over 128 KiB and Windows limits the whole command line to 32,767 characters. `--json-schema` takes only inline JSON, so a very large schema can still hit that limit. Images go as `image` blocks in the stream-json user message. `responseSchema` goes to `--json-schema`, and the `result` message carries the parsed answer in `structured_output`. All three were verified live on 2.1.285. A `none` run with an image and a schema used about 1,200 input tokens.

## Agent callbacks and events

These features follow [Agent callbacks and events](../run-options.md#agent-callbacks-and-events). They were checked against Claude Code 2.1.310 with recorded fixtures in `test/fixtures/claude/` and the live runs described below. The capabilities are `mcpServers: ["http", "stdio"]`, `apiKey`, `plan`, `fileChanges`, `questions`, `approvalInput` and `sandbox`.

### Tool prompts

`--permission-prompt-tool stdio` makes the CLI send each tool prompt to cli-funnel as a `can_use_tool` request instead of denying it. It is passed when the caller is asked about approvals (`onApproval` at `supervised`, `accept-edits` or `auto`), when `onQuestion` is set at any level but `none`, and when an HTTP server has `autoApprove` below `full`. A prompt the caller would not have been asked about before, such as a Bash command at `full` with only `onQuestion` set, is denied by cli-funnel with the CLI's own wording ("Claude requested permissions to use Bash, but you haven't granted it yet."), so those runs behave as they did. The flag also turns on AskUserQuestion, which `-p` mode leaves out otherwise. A run that only has an auto-approved server can therefore see the agent call AskUserQuestion and get it denied.

### Approval replies

A deny with `message` goes to the CLI as `{behavior: "deny", message}`, and the model reads it as the tool's error. Live check: a `supervised` run denied `touch marker.txt` with "Blocked by policy ZEBRA-42: list files through the app instead.", and the answer quoted that text word for word. `updatedInput` on an allow replaces the tool input.

### MCP servers

The MCP config is written to a private temp file (mode 0600) and passed as `--mcp-config=<file>`, because headers and env often carry tokens that argv would show to other users of the machine. This holds whether the servers came from `mcpServers`, from `providerOptions.claude.mcpConfig` or from both. The file is removed after the run, or after the first turn of a live session. Each server becomes `{type: "http", url, headers, timeout}` or `{type: "stdio", command, args, env, timeout}`. It is merged with `providerOptions.claude.mcpConfig`, which stays `full` only, and a name in both fails the run with `invalid-selection`. A server with the same name as one in the user's own config replaces it for the run.

`toolTimeoutSec` becomes the server's `timeout` in milliseconds. Claude Code 2.1.310 reads it per server and prefers it over the `MCP_TOOL_TIMEOUT` environment variable. It also raises the idle timeout of HTTP servers (5 minutes by default) to the same value. Live check: a server whose tool waits 8 seconds, with `toolTimeoutSec: 3`, failed with `MCP server "cftest" tool "slow_echo" timed out after 3s`.

`autoApprove` allows that server's tool calls without `onApproval`. The `can_use_tool` request names the server as configured (`mcp_server: {name, source}`), and cli-funnel allows the call only when the name is one of the caller's auto-approved servers and the source is `dynamic`, which means `--mcp-config`. It does not use `--allowed-tools=mcp__<name>`: tool names are normalized, so that rule also matched the tools of the claude.ai connector "claude.ai Claude Docs" when the caller named a server `claude_ai_Claude_Docs`. Live check: a `supervised` run whose `onApproval` denied everything called a tool on a local HTTP MCP server with an `Authorization` header. The tool ran with no approval asked, and the server logged the header on every request.

### Plans

Claude Code 2.1.310 picks the plan tool by model. Claude 4.x and older models (Haiku 4.5, Sonnet 4.6, Opus 4.7 and earlier) get TaskCreate and TaskUpdate. With `CLAUDE_CODE_ENABLE_TASKS=false` they get TodoWrite instead. Newer models (Sonnet 5, Opus 5.5) get no plan tool unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set. A run with `planTool: true` sets it, except at `none`, and those models then get TaskCreate and TaskUpdate. Without it their runs emit no `plan` events.

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
| `mcpConfig: object` | `--mcp-config=<file>`, a private temp file | `full` only |
| `agents: Record<string, ClaudeAgent>` | `--agents=<json>` | all but `none` |
| `fallbackModel: string` | `--fallback-model=<ids>` | all |
| `maxBudgetUsd: number` | `--max-budget-usd=<n>` | all |
| `forkSession: boolean` | `--fork-session`, needs `sessionId` | all |
| `forwardSubagentText: boolean` | `--forward-subagent-text` | all |
| `forwardSubagentTools: boolean` | none, the parser keeps the calls | all |
| `betas: string[]` | `--betas=<header>` | all |
| `ephemeral: boolean` | `--no-session-persistence`. Refused with `sessionId` | all |

`ephemeral` runs without saving the session to disk, so it cannot be resumed. It works in live sessions too, checked on 2.1.319: one process with the flag answered two turns, and the second turn remembered a word from the first, because the process keeps the conversation in memory. Pass the same `ephemeral` on every turn of a live session, since a turn with other options starts a new process (see [Live sessions](../sessions.md)). That new process would have to resume a session that was never saved, and `ephemeral` with a `sessionId` is refused.

`forkSession` works on live sessions: the fork gets its own process and the parent's stays up. See [Live sessions](../sessions.md#fork-a-session).

`forwardSubagentText` makes Claude Code send the subagents' messages with `parent_tool_use_id` set to the id of the `Agent` call. cli-funnel turns each text block into a `subagent.text` event with that id as `parentId`. Without the flag, Claude Code 2.1.300 sent only the subagent's prompt, as a `user` message with `parent_tool_use_id`, and the parser drops it. Claude Code 2.1.316 sent the subagent's tool calls and text without the flag too, and the parser keeps the text only when `forwardSubagentText` is on. A subagent's `assistant` message arrives whole, not as stream deltas, and its thinking block is empty. The parser ignores the subagent's prompt and thinking, and its tool calls unless `forwardSubagentTools` is on. `test/fixtures/claude/subagent-text.ndjson` is a recorded run, with ids replaced.

`forwardSubagentTools` turns a subagent's `tool_use` blocks into `tool.start` events and its `tool_result` blocks into `tool.end` events. Both carry `parentId`, the id of the `Agent` call, and `agent`, the `subagent_type` Claude Code puts on the message. Claude Code 2.1.316 sends these messages without any flag, so the option only tells the parser to keep them. A subagent's Write or Edit call produces no `file.change`, its TodoWrite and task calls do not change the run's `plan`, and its calls stay out of `result.toolCalls`. A call the `result` lists in `permission_denials` ends a second time as denied, as a call of the main agent does, and keeps its `parentId`. Approvals are unchanged: a subagent's tool prompt already went to `onApproval`. `test/fixtures/claude/subagent-tools.ndjson` is a recorded run on 2.1.316 with a subagent that reads one file, with ids and paths replaced.

`mcpConfig` and `agents` take objects, not file paths. A subagent may set `description`, `prompt`, `tools`, `disallowedTools` and `model`. `maxBudgetUsd` compares against the CLI's list-price estimate, which is not what a subscription pays. `betas` only matters for API key logins. See [Run options](../run-options.md#provider-options) for why each limit is where it is.

## Subagents

| What the subagent does | What cli-funnel emits |
| --- | --- |
| the `Agent` call that starts it | `tool.start` and `tool.end`, always |
| its tool calls | `tool.start` and `tool.end` with `parentId` and `agent`, with `forwardSubagentTools` |
| its text | `subagent.text` with `parentId` and `agent`, with `forwardSubagentText` |
| its thinking | nothing: the CLI sends it empty |

See [Provider options](#provider-options) for how each one works.

## Usage windows

`funnel.rateLimits("claude")` starts the CLI, sends the control request `{"subtype": "get_usage", "skip_behaviors": true}` and stops it. No model turn runs and nothing is saved: the process starts with `--tools ""`, `--strict-mcp-config`, `--setting-sources ""` and `--no-session-persistence`, so none of your hooks, MCP servers or settings start. An answer took about 0.5 s on 2.1.319. `skip_behaviors` stops the CLI from scanning your local transcripts for the part of the answer that cli-funnel does not read. A recorded answer is in `test/fixtures/claude/get-usage.json`, with the account data left out.

| Answer field | `RateLimits` |
| --- | --- |
| `subscription_type` (`"max"`) | `plan` |
| `rate_limits.five_hour` | `primary`, with `windowMinutes: 300` |
| `rate_limits.seven_day` | `secondary`, with `windowMinutes: 10080` |
| `utilization` | `usedPercent`, a percentage from 0 to 100 as the CLI's own schema says |
| `resets_at` (`"2026-11-10T00:40:00.921556+00:00"`) | `resetsAt`, as an ISO 8601 timestamp in UTC |

The CLI also reports weekly windows per model and the extra usage balance. They are not read. `limit` is set when a window is at 100%, the five-hour window first, with the same wording as the `limit` event ("Claude five-hour limit reached."). The answer has no separate flag for a full window, so a window at 100% is the only signal, and no full window was seen while testing. A login with an API key has no windows (`rate_limits` is `null`), so the result is `{ provider: "claude" }` with no `plan`.

The CLI calls this request experimental and says its shape may change. The call throws `unsupported` when the CLI answers with an error, exits without an answer, or does not answer in 30 seconds, and `not-installed` when there is no `claude` binary. The messages are fixed text: the CLI's own error and stderr can hold account details, so they are not copied into them.

## Models

Claude has no list command, so models come from `data/models/claude.json`.

| Id | Efforts | Notes |
| --- | --- | --- |
| `claude-fable-5-2` | low to max | 1M context. Not tested on a Pro plan, where 5.1 needs usage credits (see below) |
| `claude-fable-5-1` | low to max | Needs usage credits on a Pro plan (the run returns a 429 error) |
| `claude-opus-5-5` | low to max | 1M context |
| `claude-sonnet-5` | low to max | 1M context |
| `claude-opus-4-6` | low, medium, high, max | 200k context, or 1M with `contextWindow: 1000000` |
| `claude-haiku-4-5-20251001` | none listed | 200k context |

Each id was run with `claude -p` and `init` reported the same id back. In an earlier test on a Pro plan, Fable 5.1 resolved and was then refused for credits. Aliases such as `opus` are not listed.

`claude-fable-5-2` was run on 2.1.319 with each of the five `--effort` values and once without one. `init` reported `claude-fable-5-2` every time, the result was `ok` with no error, and `modelUsage.contextWindow` was 1,000,000. The CLI prints `[claude-code:unrecognized_model]` on stderr for this id (its bundled model table predates 5.2), and cli-funnel ignores the line because it does not start with `Warning:`. The same runs with `claude-fable-5-1` also succeeded, so 5.1 stays listed. Neither Fable id was refused for credits on that subscription, whose plan was not recorded, so the Pro plan note for 5.1 still comes from the earlier test, and 5.2 has not been run on a Pro plan.

Effort: the CLI accepts `--effort` values `low`, `medium`, `high`, `xhigh` and `max` for every model tried, and only warns on unknown values. It gives no per-model list, so per-model support is not checked. Haiku accepts the flag but no effort is offered for it. No default effort is set, so the CLI decides.

Context: Claude Code picks a model's 1M context variant through a `[1m]` suffix on the model id. A selection with `contextWindow: 1000000` on a model that lists `[200000, 1000000]` in `contextWindows` runs with `--model '<id>[1m]'`, and the `session` event reports the suffixed id. Without `contextWindow`, or with the default, the id goes unchanged.

Tested on 2.1.300 with `modelUsage.contextWindow` from the result:

- `claude-opus-4-6` reports 200,000, and `claude-opus-4-6[1m]` reports 1,000,000.
- Sonnet 5, Opus 5.5 and Fable 5.1 already report 1,000,000 without the suffix, so they list no context sizes. Fable 5.2 reported the same on 2.1.319.
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

### Steer

`funnel.steer(sessionId, text)` writes a `user` line with a fresh `uuid` and `priority: "next"` to the live process. Claude Code reads such a message in the running turn as soon as the tool calls it is running finish. A message that arrives while the model only writes text, or after the turn's work is done, waits in Claude Code's queue and runs after the turn as a turn of its own, with its own `result`.

cli-funnel tells the two cases apart from the stream, so a funnel turn still ends exactly once:

- Claude Code reports each message sent with a `uuid` in `command_lifecycle` lines: `queued` when it arrives, `started` when a turn takes it in, then one of `completed`, `cancelled`, `discarded` or `refused`. A `result` also lists the messages its turn took in, in `user_message_uuids`.
- When a `result` arrives while a steer message is still `queued`, the funnel turn goes on. The `done` of that result is held back, the next turn's `init` is not reported again, and the turn ends at the next `result`. Its `done.text` is that last answer, and its `usage` is the sum of both.
- A queued message that ends as `cancelled`, `discarded` or `refused` gets no answer, so the turn ends with the held `done`.
- A turn that fails while a steer message is queued ends with its error, and the process stops, because Claude Code would answer the message as the next turn. The next turn resumes the session in a new process.

`steer` needs the `msg_lifecycle_v1` capability in the `system` / `init` message. A version without it lists `steer: false` in `funnel.sessions()`, and `steer` throws `unsupported`. Once the turn has decided to end at a `result`, `steer` throws `invalid-selection`.

Tested on 2.1.319 with `claude-haiku-4-5-20251001`:

- A steer sent at the first Bash call of a turn that ran `sleep 3` three times was read after that call. The turn had one `result`, with `num_turns: 4`, and answered `DONE. PINEAPPLE.` as the steer asked.
- A steer sent while the model wrote a story was answered after it in a second `result`. The funnel turn ended once, with `MANGO.` as its text.
- A steer written when the last text block arrived, 14 ms before `result`, was not in that result. Claude Code answered it in a second turn.
- A steer blocked by a `UserPromptSubmit` hook ended as `completed` with no answer when it arrived during tool calls. When it arrived after the work, it still got a `result` of its own, with the hook's notice as its text and `num_turns: 0`.

## Subscription limits and the entry point

On Pro and Max plans, runs through cli-funnel can use up the five-hour window faster than the same work in the interactive CLI. The reports below are about the five-hour window only.

Claude Code tags its requests with an entry point. In `-p` mode, which cli-funnel always uses, the CLI reports `sdk-cli` unless `CLAUDE_CODE_ENTRYPOINT` is already set in its environment. It also changes an inherited `cli` to `sdk-cli`, so starting cli-funnel from an interactive Claude Code session does not change it. This was checked in Claude Code 2.1.316.

Users report that `sdk-cli`, and the Agent SDK's `sdk-ts` and `sdk-py`, use about 1.8 times more of the five-hour window per token than the interactive CLI ([anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074)). Anthropic has not documented a different rate, and cli-funnel has not measured it. Anthropic removed the five-hour window for verified Ultra accounts on 2026-11-02, so those accounts are not affected.

cli-funnel does not set `CLAUDE_CODE_ENTRYPOINT`. The variable is not in Claude Code's documented settings, and Anthropic has not said whether subscribers may set it ([anthropics/claude-code#107106](https://github.com/anthropics/claude-code/issues/107106)). T3 Code sets it to `t3-code`, and its author says Anthropic agreed to that informally. Whether you set it for your own app is your decision, so read [Terms and limits](../tos-notes.md) first.

To set it for one run, pass it in `env`. A value in `env` wins over the parent environment:

```ts
await funnel.run({
  prompt: `Summarise this issue in one sentence:\n\n${issueText}`,
  selection: { provider: "claude", model: "claude-sonnet-5", cwd: projectDir, access: "none" },
  env: { CLAUDE_CODE_ENTRYPOINT: "my-app" },
});
```

To set it for every run, set it in the environment that starts cli-funnel, for example before `cli-funnel serve` or `cli-funnel mcp`. The CLI inherits that environment.

## Known limits

- Fast mode is unavailable.
- Approval requests other than `can_use_tool` are answered with an error.
- Sonnet 5 and Opus 5.5 have no plan tool by default, so they emit no `plan` unless the run sets `planTool`.
- Shell commands and subagents produce no `file.change`.
- Resume needs the same cwd as the original run, because Claude stores sessions per project directory.
- The `paste` and other MCP servers that need auth print a note in the model's reply, not an error.
