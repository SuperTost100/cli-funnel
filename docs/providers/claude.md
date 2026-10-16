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
| Approvals | `--permission-prompt-tool stdio` |
| Resume | `--resume <sessionId>` (same cwd as the first run) |
| Working directory | The process cwd is `selection.cwd` |
| Cancel | The abort signal sends SIGTERM |

## Stream mapping

| Claude output | FunnelEvent |
| --- | --- |
| `system` / `init` | `session` (session id, resolved model) |
| `text_delta` | `text.delta` |
| `thinking_delta` | `reasoning.delta` (Claude often sends empty thinking text) |
| `assistant` `tool_use` block | `tool.start` |
| `user` `tool_result` block | `tool.end` (`error` when `is_error`) |
| `control_request` `can_use_tool` | `approval.request` |
| `result` | `usage`, then `done` (or `error` when `is_error`) |

Usage has no `costUsd`. The CLI reports a list-price estimate, not what a subscription is charged. Subagent messages are dropped.

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
| `betas: string[]` | `--betas=<header>` | all |

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
- Resume needs the same cwd as the original run, because Claude stores sessions per project directory.
- The `paste` and other MCP servers that need auth print a note in the model's reply, not an error.
