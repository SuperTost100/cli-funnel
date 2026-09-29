# Cursor Agent (`agent`)

Provider id `agent`. Spawns the official `agent` binary in print mode and reads its `stream-json` output. Tested against 2026.09.26 and 2026.09.28. Minimum tested version is 2026.09.01.

## Capabilities

| Field | Value |
| --- | --- |
| access | `auto`, `full` |
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

The process runs with `cwd` set to the selection's directory. Aborting the signal sends SIGTERM and yields `done` with `finishReason: "cancelled"`.

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
| `accept-edits` | not offered, the CLI has no such flag |
| `supervised` | not offered, see below |

Print mode has "access to all tools, including write and shell" per `--help`. On the machine used to build this provider, plain `-p` without any flag wrote files and ran shell commands, because that user's `~/.cursor/cli-config.json` has `approvalMode: "unrestricted"`. The provider never runs without one of the two flags, so `full` and `auto` are explicit and do not depend on the user's config.

### Why there is no `supervised`

`agent acp` speaks Agent Client Protocol over stdio and defines `session/request_permission`. In testing, an ACP session that created a file never sent a permission request, and the file was written. The modes offered are `agent`, `plan` and `ask`, with no way to force approval prompts from the client. With the tested config the approve button could not be reached, so `supervised` and `approvals` are off. This was not tested against a config that gates tools, so the ACP route may work there. Revisit if that changes.

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
- `finishReason: "denied"` is set only when a tool result has a `rejected` or `permissionDenied` key. That shape was not observed.
- The version suffix (`-dd393fe`) is compared as a number by `compareVersions`. This is harmless for the minimum check.
- Only the `agent` binary name is searched, not the `cursor-agent` alias.
