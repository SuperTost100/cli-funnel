# Cursor Agent (`agent`)

Provider id `agent`. Spawns the official `agent` binary in print mode, writes the prompt to its stdin and reads its `stream-json` output. A prompt on stdin has no argument size limit. Tested against 2026.09.26, 2026.09.28, 2026.10.01 and 2026.10.22. Minimum tested version is 2026.09.01.

## Capabilities

| Field | Value |
| --- | --- |
| access | `none`, `auto`, `full` |
| effort | yes |
| fast | yes |
| contextWindow | no |
| resume | yes |
| approvals | no |
| apiKey | yes |
| mcpServers | `http`, `stdio` |
| plan | yes |
| fileChanges | yes |
| questions | no |

## Command line

```bash
agent -p --output-format stream-json --stream-partial-output \
  --model <id> --workspace <cwd> --trust [access flag] [--resume <sessionId>] \
  [--plugin-dir <dir>] < prompt
```

The process runs with `cwd` set to the selection's directory. At `none` both `cwd` and `--workspace` are the `none` folder described below. Aborting the signal sends SIGTERM and yields `done` with `finishReason: "cancelled"`.

## Stream mapping

| CLI line | Event |
| --- | --- |
| `system` / `init` | `session` (the chat id, reused for `--resume`), with `auth` from `apiKeySource`: `login` is `account`, `env` and `flag` are `api-key` |
| `assistant` with `timestamp_ms` | `text.delta` |
| `assistant` without `timestamp_ms` | skipped, it repeats the deltas |
| `thinking` / `delta` | `reasoning.delta` |
| `tool_call` / `started` | `tool.start` (name is the key minus `ToolCall`, for example `shell`, `edit`, `read`) |
| `tool_call` / `completed` | `tool.end` with `output` or `error` |
| `editToolCall` and `deleteToolCall` completed | `file.change` after the `tool.end`, see [File changes](#file-changes) |
| `updateTodosToolCall` and `createPlanToolCall` completed | `plan`, see [Plans](#plans) |
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

### Provider options

`providerOptions.agent` maps to these flags, checked against 2026.10.01:

| Option | Flag | Access levels |
| --- | --- | --- |
| `addDirs: string[]` | `--add-dir=<dir>`, absolute paths | `auto`, `full` |
| `sandbox: "enabled" \| "disabled"` | `--sandbox=<value>` | `enabled` at all levels, `disabled` at `full` only |
| `mode: "plan"` | `--mode plan` | `auto`, `full` |

`none` refuses `mode: "plan"` and keeps `--mode ask`. Nobody has tested whether plan mode can write its plan file outside the empty `none` folder. On this machine `--sandbox enabled` failed to start because of the AppArmor setup, so check that the sandbox works where you run it.

## API key

`apiKey` runs the CLI on a Cursor API key instead of the saved login. The key goes to the process as `CURSOR_API_KEY`, never as `--api-key`, because argv is visible to other users in `ps`. `result.auth` and the `session` event say `api-key`.

Checked on 2026.10.22:

- A key in `CURSOR_API_KEY` wins over a saved login. A key the CLI rejects fails the run ("The provided API key is invalid", exit 1) and does not fall back to the account.
- With a key, the CLI signs in and saves the new tokens and the key into its credential store (`~/.config/cursor/auth.json` on Linux, the keychain on macOS), which replaces the saved login. This is in the bundled source (`setAuthentication` in the API key path). It was not run with a valid key, because none was available.
- `AGENT_CLI_CREDENTIAL_STORE=memory` switches the store to memory. With it set, `agent status` reports "Not logged in" on a machine with a saved login, so the saved login is neither read nor written. The variable works on every platform and is not in `--help`.

So a run with `apiKey` sets `CURSOR_API_KEY` and `AGENT_CLI_CREDENTIAL_STORE=memory`. Before the first such run in a process, it runs `agent status` with the memory store and refuses the run (`unsupported`) unless the CLI answers `"isAuthenticated": false`. If a future CLI ignores the variable, the key would overwrite the saved login, and this check stops that. The run also lists models with the key, because the models can differ per account, and it cuts the key and the MCP header values out of error text.

The agent's own shell tool inherits the process environment, so at `full` it can read `CURSOR_API_KEY`. The live test (`CLI_FUNNEL_TEST_CURSOR_KEY=<key> npx vitest run test/agent-features.test.ts`) checks that the saved login file is unchanged. It is skipped without the key.

## Plans

The agent keeps a todo list with `updateTodosToolCall`. Its `completed` result carries the whole merged list, even though the call itself sends only the changed items (`merge: true`), so each completed call becomes one `plan` event with every step. Statuses map as `PENDING` to `pending`, `IN_PROGRESS` to `in_progress`, `COMPLETED` to `done`. A `CANCELLED` item is left out, because `PlanStep` has no such status and the item is no longer part of the plan.

In `--mode plan` the agent calls `createPlanToolCall` with a Markdown plan and a todo list. The provider emits a `plan` event with those todos and the plan's `overview` as `explanation`. The Markdown body is not forwarded. The headless CLI accepts the plan on its own.

Whether the agent writes a todo list depends on the model and the prompt. Small tasks often get none.

## File changes

`editToolCall` and `deleteToolCall` become one `file.change` each, after the `tool.end`, with the `id` of the `tool.start`. The CLI has no write tool and no rename: new files also go through `editToolCall`, and a move is a delete plus an add.

- `path` is made absolute with the `cwd` from the `init` line when the agent used a relative one.
- `kind`: an edit result without `beforeFullFileContent` and with a diff from `/dev/null` is `add`, one with `beforeFullFileContent` is `update`. A patch-style result (GPT models) lists `A`, `M` or `D` lines in its message, which give the kind and produce one event per file. Only the `A` form was recorded, `M` and `D` follow git's letters. When the result says nothing, the kind comes from a check made when the edit started: `index.ts` passes `existsSync` to the mapper, which stays free of file access.
- `status`: `done` for a success. `declined` when a permission rule refused it (`permissionDenied`, `rejected`, `readPermissionDenied`, or `writePermissionDenied` with "Blocked by permissions configuration"). `failed` for everything else, for example a missing file or a folder the operating system won't let the process write to (also `writePermissionDenied`, with "Permission denied").

Calls that end with no result produce no event. The same split drives `finishReason: "denied"`, so a file the OS refused to write no longer counts as a denial.

## MCP servers

`mcpServers` attaches the caller's servers for one run without writing to the project or to `~/.cursor`.

The CLI reads MCP servers from `<workspace>/.cursor/mcp.json` and `~/.cursor/mcp.json` (the home path is fixed). `--add-dir` does not help: a server in an added folder's `.cursor/mcp.json` was not loaded (checked, the namespace was "not found"). `--plugin-dir` does work. A plugin folder with `.cursor-plugin/plugin.json` and `.mcp.json` loads its servers under the name `plugin-<folder>-<server>`.

The provider writes such a folder to `~/.cache/cli-funnel/workspaces/agent-mcp/<hash>/funnel/` and passes `--plugin-dir`. The CLI expands `${env:NAME}` in the plugin's MCP config, in URLs, headers, commands, arguments and `env` values. The config file therefore holds only references (`CLI_FUNNEL_MCP_0_URL`, `CLI_FUNNEL_MCP_0_H0`, ...) and the values travel in the process environment. No token lands on disk or in argv, and the folder name is a hash of the config, so runs with the same server names and header names share it.

| Type | Levels | Notes |
| --- | --- | --- |
| `http` | `auto`, `full` | `url` and `headers` |
| `stdio` | `full` | `command`, `args`, `env` |

- Plugin servers need no approval, so `--approve-mcps` is not passed. It would also approve every unapproved server in the user's own config, and the approvals live in a file under `~/.cursor`, which this provider must not write.
- At `auto` the classifier lets the calls through. At `full` `--force` does. Both were run live with a local server that checks the `Authorization` header (`test/agent-mcp-live.test.ts`, `CLI_FUNNEL_LIVE=1`).
- `none` is refused by the contract, and its deny rules block `Mcp(*:*)` anyway. `supervised` does not exist here.
- `toolTimeoutSec` fails the run with `unsupported`: the MCP config has no timeout field.
- `autoApprove` has no effect. There is no approval step to skip.
- The model sees the tools as `plugin-funnel-<server>-<tool>`. The stream reports them as `mcp` tool calls whose input holds the server and tool name.
- The user's own MCP servers still load as before.

## Questions

Not supported. The CLI has an ask-question tool (`askQuestionToolCall`) and prints an `interaction_query` line when the model uses it, but in print mode it answers the query itself, immediately and with a rejection ("Questions skipped by the user, continue with the information you already have"). There is no flag or stdin message to answer it, and print mode takes no input stream. The model then continues without an answer. The run shows a `tool.end` with that error and no `question.request`, and it is not counted as a denial. `capabilities.questions` stays off, and `onQuestion` is ignored.

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
- `finishReason: "denied"` is set when a tool result has a `rejected`, `permissionDenied` or `readPermissionDenied` key, or a `writePermissionDenied` whose message says "permissions configuration". Those calls also end with an error that starts with `denied:`, so they show up in `result.deniedActions`. A skipped question is not a denial, and neither is a file the operating system would not write. A read refused by a `Read` rule comes back as a plain `Permission denied` error and is not counted.
- The version suffix (`-dd393fe`) is compared as a number by `compareVersions`. This is harmless for the minimum check.
- Only the `agent` binary name is searched, not the `cursor-agent` alias.
