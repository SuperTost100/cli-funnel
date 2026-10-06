# Cursor Agent (`agent`)

Provider id `agent`. Spawns the official `agent` binary in print mode and reads its `stream-json` output. Tested against 2026.09.26, 2026.09.28 and 2026.10.01. Minimum tested version is 2026.09.01.

## Capabilities

| Field | Value |
| --- | --- |
| access | `none`, `auto`, `full` |
| effort | yes |
| fast | yes |
| contextWindow | no |
| resume | yes |
| approvals | no |

## Command line

```
agent -p --output-format stream-json --stream-partial-output \
  --model <id> --workspace <cwd> --trust [access flag] [--resume <sessionId>] -- <prompt>
```

The process runs with `cwd` set to the selection's directory. At `none` both `cwd` and `--workspace` are the `none` folder described below. Aborting the signal sends SIGTERM and yields `done` with `finishReason: "cancelled"`.

## Stream mapping

| CLI line | Event |
| --- | --- |
| `system` / `init` | `session` (the chat id, reused for `--resume`) |
| `assistant` with `timestamp_ms` | `text.delta` |
| `assistant` without `timestamp_ms` | skipped, it repeats the deltas |
| `thinking` / `delta` | `reasoning.delta` |
| `tool_call` / `started` | `tool.start` (name is the key minus `ToolCall`, for example `shell`, `edit`, `read`) |
| `tool_call` / `completed` | `tool.end` with `output` or `error` |
| `result` success | `usage`, then `done` |
| `result` error, or exit without a result | `error` |

Usage: `inputTokens` is input plus cache read plus cache write, `cachedInputTokens` is cache read. No cost is reported.

## Access mapping

| Access | Flag |
| --- | --- |
| `full` | `--force` |
| `auto` | `--auto-review` (a server classifier runs safe calls and holds the rest) |
| `none` | `--mode ask`, run in a folder whose deny rules block every tool |
| `accept-edits` | not offered, the CLI has no such flag |
| `supervised` | not offered, see below |

Print mode has "access to all tools, including write and shell" per `--help`. On the machine used to build this provider, plain `-p` without any flag wrote files and ran shell commands, because that user's `~/.cursor/cli-config.json` has `approvalMode: "unrestricted"`. The provider never runs without one of the two flags, so `full` and `auto` are explicit and do not depend on the user's config.

### Why there is no `supervised`

`agent acp` speaks Agent Client Protocol over stdio and defines `session/request_permission`. In testing, an ACP session that created a file never sent a permission request, and the file was written. The modes offered are `agent`, `plan` and `ask`, with no way to force approval prompts from the client. With the tested config the approve button could not be reached, so `supervised` and `approvals` are off. This was not tested against a config that gates tools, so the ACP route may work there. Revisit if that changes.

### How `none` works

`--mode ask` is documented as read-only, but on 2026.09.28 `--mode ask --sandbox enabled` still ran `ls ~` through the shell tool. Ask mode alone is not enforcement.

The CLI reads `.cursor/cli.json` from every folder between the git root and the process cwd, and merges its `permissions` into the user's config. A deny rule wins over any allow rule, over `approvalMode` and over `--force`. At `none` the provider runs the CLI in `~/.cache/cli-funnel/workspaces/agent-none/`, which holds only this file:

```json
{ "permissions": { "allow": [], "deny": ["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)", "Mcp(*:*)"] } }
```

Verified on 2026.10.01, with and without `--force` and `--mode ask`:

- Shell commands are refused with "Command blocked by permissions configuration". This covers `bash -c`, `python3 -c`, `env`, pipes, the user's own `Shell(ls)` allow rule, read-only commands in ask mode, and shell calls from a `Task` subagent.
- Edits, deletes and reads are refused. Grep and glob ignore paths outside the workspace and see only `.cursor/cli.json`.
- MCP tools from a plugin loaded with `--plugin-dir` are refused with "Blocked by permissions configuration".

`--mode ask` stays on so the model rarely tries a tool at all. Resume works, because every `none` run uses the same folder.

### Run options

The CLI has no system prompt or schema flag. `system` goes in front of the prompt inside `<instructions>`, and `responseSchema` is asked for at the end of the prompt. The result is parsed into `structured` like any other. Images are refused.

## Models

`agent --list-models` prints flat ids such as `gpt-5.3-codex-high-fast` and `claude-opus-5-thinking-high`. `models()` groups them:

- Base id: the flat id without the effort token and the trailing `fast`. `thinking` stays in the base, so `claude-opus-5` and `claude-opus-5-thinking` are separate models.
- `efforts`: none, minimal, low, medium, high, xhigh, max, in that order. `extra-high` (GPT-5.5) is exposed as `xhigh`.
- On `gpt-*`, an id with no effort token next to effort variants is the medium tier.
- `fast`: true when any variant ends in `-fast`. Not every effort has a fast variant.
- `auto` is dropped.
- `contextWindows` is empty. Context size is fixed per id (for example `1M` in the name).

`toCliModel(selection, knownIds)` rebuilds the flat id and checks it against the list. It throws `invalid-selection` for a combination the CLI does not list, for example fast on `claude-sonnet-5-5`. Without a list it returns the most likely id.

The CLI also accepts bracket ids such as `gpt-5.4-nano[reasoning=low]`, and this works. It is not used because the key name differs per family (`reasoning`, `effort`, `reasoning_effort`), value sets are not listed, and a wrong key produces no output and no error.

`data/models/agent.json` is an offline copy of the grouped list. It has no flat ids, so `toCliModel` falls back to its default pattern when offline. Old Claude ids that put `thinking` after the effort (`claude-4.6-opus-max-thinking`) need the live list to resolve.

## Login, logout, update

- `authStatus()` runs `agent status --format json` and `agent about --format json`. It exposes only the account email and the plan.
- `login()` runs `agent login` with `NO_OPEN_BROWSER=1` and surfaces the URL as an `open-url` event. Set `CLI_FUNNEL_OPEN_BROWSER=1` in the host process to let the CLI open the browser.
- `logout()` runs `agent logout`. `update()` runs `agent update`. These were written from `--help` and were not run.
- A non-zero exit with "Authentication required" on stderr becomes an error with code `not-logged-in`.

## Known limits

- No `supervised` or `accept-edits`.
- At `none` the model still gets its tool definitions, so a one-line prompt costs about as much as at `full`.
- `finishReason: "denied"` is set when a tool result has a `rejected`, `permissionDenied` or `readPermissionDenied` key. Those calls also end with an error that starts with `denied:`, so they show up in `result.deniedActions`. A read refused by a `Read` rule comes back as a plain `Permission denied` error and is not counted.
- The version suffix (`-dd393fe`) is compared as a number by `compareVersions`. This is harmless for the minimum check.
- Only the `agent` binary name is searched, not the `cursor-agent` alias.
