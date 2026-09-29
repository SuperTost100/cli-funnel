# Claude Code provider

Runs the real `claude` binary in print mode and reads its stream-json output. Tested with Claude Code 2.1.283 (supported range starts at 2.1.0). It never uses `--bare`, so your subscription login is used.

## Flags

| Purpose | Flags |
| --- | --- |
| Run | `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` |
| Prompt | One `user` JSON line on stdin. Stdin closes after the `result` message. |
| Model | `--model <id>` |
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
| `supervised` | `manual` | Every prompt goes to `onApproval` |
| `accept-edits` | `acceptEdits` | Other prompts go to `onApproval` when it is set |
| `auto` | `auto` | Same as above |
| `full` | `bypassPermissions` | None |

Approvals work. The CLI writes a `control_request` (subtype `can_use_tool`) to stdout and waits. The provider answers on stdin with a `control_response` carrying `{behavior: "allow", updatedInput}` or `{behavior: "deny", message}`. This only happens with `--permission-prompt-tool stdio`. The `--permission-prompts host` flag alone is not enough: without the stdio tool the CLI denies the call and lists it in `permission_denials`, and `done` gets `finishReason: "denied"`. The help text lists `manual` as the mode name, not `default`, though `init` reports it as `default`.

## Models

Claude has no list command, so models come from `data/models/claude.json`.

| Id | Efforts | Notes |
| --- | --- | --- |
| `claude-fable-5-1` | low to max | Needs usage credits on a Pro plan (the run returns a 429 error) |
| `claude-opus-5-5` | low to max | 1M context |
| `claude-sonnet-5` | low to max | 1M context |
| `claude-haiku-4-5-20251001` | none listed | 200k context |

Each id was run with `claude -p` and `init` reported the same id back, except Fable, which resolves but is then refused for credits. Aliases such as `opus` are not listed.

Effort: the CLI accepts `--effort` values `low`, `medium`, `high`, `xhigh` and `max` for every model tried, and only warns on unknown values. It gives no per-model list, so per-model support is not checked. Haiku accepts the flag but no effort is offered for it. No default effort is set, so the CLI decides.

Context: `--model 'claude-sonnet-5[1m]'` is accepted and reports a 1,000,000 window. Sonnet 5 and Opus 5.5 already report 1M without the suffix on this account, so `contextWindow` is not a setting here. Other plans may differ.

## Fast mode

Not supported. `fastMode` is a Claude Code setting, but in SDK-style runs the CLI reports `fast_mode_disabled_reason: "sdk_opt_in_required"` and it needs extra usage enabled on the account. It was not confirmed to work headlessly, so `fast` is false.

## Login, logout, update

- `login()` runs `claude auth login` (subscription login). It opens a browser page. If the CLI asks for a pasted code, use `sendCode`. Options such as `--console`, `--sso` and `--email` are not exposed.
- `logout()` runs `claude auth logout`.
- `update()` runs `claude update`.
- `authStatus()` reads `claude auth status`. The org id is not returned. Login, logout and update were not run during development, to protect the local install.

## Known limits

- Fast mode and context window selection are unavailable.
- Approval requests other than `can_use_tool` are answered with an error.
- Resume needs the same cwd as the original run, because Claude stores sessions per project directory.
- The `paste` and other MCP servers that need auth print a note in the model's reply, not an error.
