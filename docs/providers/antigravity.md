# Antigravity

Provider id `antigravity`. Binary `agy`. Tested against 1.2.11 through 1.3.0 and 1.4.6 to 1.4.7, minimum 1.2.0. The file changes, plans, MCP servers and API key sections below were checked on 1.4.6 and 1.4.7 only.

Runs use `agy --print=<prompt> --output-format stream-json` with stdin closed. Linux refuses a single argument over 128 KiB, so a prompt over 100 KB goes on stdin instead (over 30 KB on Windows, where the whole command line is limited to 32,767 characters): `--print= --input-format stream-json` and one line `{"event":"user","message":{"content":"..."}}`. agy does not document that message shape. It is what agy 1.x decodes. The stream carries an `init` event, `step_update` events (text deltas and tool steps) and a final `result` with token usage and `denied_actions`.

## Capabilities

| Feature | Supported |
| --- | --- |
| Access levels | `none`, `accept-edits`, `full` |
| Effort | yes |
| Context window | no |
| Fast mode | no |
| Resume | yes |
| Approvals | no |
| File changes | yes, from the file tools and a plain `rm` |
| Plans | yes, when the agent keeps a `task.md` |
| MCP servers | `http` and `stdio`, at `full` only |
| API key | yes, `apiKey` runs in its own home folder |
| Questions | no |
| Sandbox | no |

## Access

`supervised` is not available. In print mode `agy` cannot ask anyone for permission. A tool that needs a permission is denied on the spot and listed in `denied_actions`, and the run continues without it. There is no request to forward, so cli-funnel cannot offer an approve button.

- `accept-edits` passes `--mode accept-edits`. Verified: file writes succeed in a workspace the user has already trusted in Antigravity (listed in `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`). In an untrusted directory such as a fresh `/tmp` folder the write is still denied. Trust the folder once in the interactive `agy` first.
- `full` passes `--dangerously-skip-permissions`. Every tool runs without a check.
- `auto` is not offered. `agy` 1.3.5 added `--mode auto`, but it is not available on every account. On an account without it, `agy` prints `warning: --mode auto is not available for this account; continuing in the default mode.` on stderr and runs in the default mode. cli-funnel cannot tell from the stream which mode ran, so it cannot promise the level. Tested on 1.3.5.

That is not true of every shell command. On 1.2.13, a `touch` outside the workspace ran without a check both in the default print mode and with `--mode plan --sandbox`. `--mode plan` has no effect together with `--disable-slash-commands`, and the CLI prints a warning saying so. Neither mode can carry `none`.

### Sandbox

`sandbox: true` is refused with `unsupported`. On 1.4.7 a run with `--dangerously-skip-permissions --sandbox` wrote `../outside.txt` from a shell command, and the stream showed no sandbox error. With `--mode accept-edits --sandbox` the command was denied, but by the permission check, which also denies commands inside the workspace. It is not known whether agy's sandbox failed to start on that host or does not cover writes. Either way agy reported nothing, so cli-funnel cannot tell a confined run from an unconfined one.

### `none`

`agy` loads `.agents/hooks.json` from the folder it runs in. A `PreToolUse` hook that answers `{"decision": "deny"}` blocks the call before any permission check. At `none` the provider runs `agy` with no mode flag in `~/.cache/cli-funnel/workspaces/antigravity-none/`, which holds only that hook file. The hook command is `cat >/dev/null; printf '%s\n' '<deny json>'` (`echo <deny json>` on Windows).

The matcher covers every tool name except `finish`. `finish` ends the turn and carries the `--json-schema` answer, and denying it breaks structured output. Go regexp has no lookahead, so the matcher spells the exclusion out.

Verified on 1.3.0:

- `run_command`, `write_to_file`, `view_file`, `call_mcp_tool` and `invoke_subagent` fail with "tool call denied by pre-tool hook". Nothing is written.
- Hooks that answer `allow`, before or after this one, do not override the deny.
- A hook that exits non-zero also blocks the call, so a broken hook fails closed.
- `--json-schema` still returns `structured_output`. Resume works, because every `none` run uses the same folder.

MCP servers from the user's config still start, but every call to them is denied. The model sees its full tool list, so the input token count is the same as at other levels. The Windows hook command has not been run on Windows.

Denied tools appear as `tool.end` events whose error starts with `denied:`. That includes calls refused by a hook, which `agy` does not list in `denied_actions`. If the run produced no text and something was denied, the finish reason is `denied`.

## Run options

The CLI has no system prompt flag, so `system` goes in front of the prompt inside `<instructions>`. `responseSchema` goes to `--json-schema`, as a path to a private temp file when the schema is over 4 KB (removed after the run), and the `result` event carries the parsed answer in `structured_output`. Verified live. Images are refused.

## Provider options

`providerOptions.antigravity` maps to these flags, checked against 1.3.6 and run live:

| Option | Flag | Access levels |
| --- | --- | --- |
| `addDirs: string[]` | `--add-dir=<dir>`, absolute paths | `accept-edits`, `full` |
| `printTimeoutSec: number` | `--print-timeout=<n>s` | all |

At `none` the run happens in a folder that holds only the deny hook, so `addDirs` is refused there.

## File changes

Each finished file write becomes a `file.change` event after its `tool.end`, with the absolute path and the status `done`, `failed` or `declined` (a hook or the permission check refused it).

| What the agent does | `kind` |
| --- | --- |
| `write_file` (`write_to_file` before 1.4) to a file the run created | `add` |
| `write_file` to a file that was there before the run, or a second write to a file in the same run | `update` |
| `edit_file` (`replace_file_content`, `multi_replace_file_content` before 1.4) | `update` |
| `run_command` that is a plain `rm`, for example `rm -rf a b` | `delete`, one event per path |

- agy sends a tool step only after the tool has run, so "did the file exist" cannot be checked when the step arrives. `add` versus `update` comes from the file's creation time: created at or after the start of the run (with a second of slack) is an `add`. Where the file system reports no creation time, or the file is gone, a `write_file` counts as an `add`.
- agy has no delete tool. Deleting goes through the shell, and only a command with no quotes, globs, variables, pipes or chaining is read as a delete. `cd x && rm y`, `rm "a b"` and `find -delete` produce a `tool.start` and `tool.end` and no `file.change`. Relative paths resolve against the folder agy reports in `init` (or the command's `Cwd`). `rm -f` of a file that is not there still reports a delete. The status comes from the command's exit code. A command the headless mode refused has no output, and counts as `declined`.
- There is no rename: `mv` is a shell command like any other, so it is not reported. `sed_file` and `notebook_edit` are not reported either, because their parameters were not checked.
- Writes into agy's own conversation folder (`~/.gemini/antigravity-cli/brain/<conversation>/`) are the agent's notes. They produce no `file.change`. A write to `task.md` there is a [plan](#plans).
- On 1.4.7, `write_file` and `edit_file` were not denied in a fresh temp folder, neither at `accept-edits` nor without a mode flag, and not outside the folder either. `declined` therefore shows up from `none` (the hook), from older versions, and from the permission check where agy has one.

## Plans

Antigravity keeps its plan as artifacts in the conversation folder: `task.md`, a checklist, and `implementation_plan.md`. The agent writes them with its normal file tools, so the stream shows only the path. When a finished write or edit targets `task.md` of the run's own conversation, cli-funnel reads the file and emits `{ type: "plan", steps }`, each time the list changes.

- `- [ ]` is `pending`, `- [/]` is `in_progress`, `- [x]` is `done`. An item with nested items is a heading, so only the nested items become steps. Bold markers are dropped.
- Plans only appear when the agent writes a `task.md`. It does in `--mode plan` and when the prompt asks for a task list. cli-funnel does not force it. Verified on 1.4.7: a prompt that asks for a task list produced the file, and the plan event followed.
- `implementation_plan.md` is not turned into steps. In `--mode plan`, which cli-funnel does not pass, the run ends after the plan with a request for approval that headless mode cannot give (observed on 1.4.7).
- cli-funnel reads only `<home>/.gemini/antigravity-cli/brain/<conversation id>/task.md`, and only up to 256 KiB.

## MCP servers

`mcpServers` attaches the caller's servers for one run without writing into the project or into agy's config. agy has no flag or environment variable for MCP servers, but it loads plugins from `.agents/plugins/<name>/` in every workspace folder, and `--add-dir` makes a folder a workspace folder. So each run:

1. creates a private folder (mode 0700) with `.agents/plugins/funnel/plugin.json` and `mcp_config.json`,
2. passes it as `--add-dir=<folder>`, and the run still happens in `selection.cwd`,
3. deletes the folder when the run ends, also when it fails or the caller stops reading.

`http` servers become `url`, `headers` and `timeoutSeconds`. `stdio` servers become `command`, `args` and `env`. Verified on 1.4.7 with a local HTTP server that the `Authorization` header arrives with `initialize`, `tools/list` and `tools/call`, that a call past `timeoutSeconds` fails with `timed out after 2s`, and with a stdio server that `env` reaches the process.

- Access: `full` only. At `accept-edits`, headless agy denies every MCP call (`permission check failed for mcp`, listed in `denied_actions`), and a `PreToolUse` hook that answers `allow` does not change that. Attaching a server there would only fail, so cli-funnel refuses with `invalid-selection`. `none` refuses MCP servers before this point. `autoApprove` has no effect, because agy never asks: it allows the call (`full`) or denies it.
- The model sees each server as `funnel_<name>`, and agy calls its tools through `call_mcp_tool` with `ServerName` and `ToolName`. The step shows up as a normal tool call.
- Servers from the user's own `~/.gemini/config/mcp_config.json` stay as they are.
- The server settings sit in a file inside the workspace, so the agent can read them with its file tools: `url` and `headers` of `http` servers, and `command`, `args` and `env` of `stdio` servers. agy also keeps a copy of each server's tool list under `~/.gemini/antigravity-cli/mcp/funnel_<name>/`. Do not put a secret in any of these settings that the agent must never see.
- Header values are written as given. agy does not expand `${VAR}` in them from the environment.
- A resumed conversation (`sessionId`) needs `mcpServers` again, because the folder is new each run.

## API key

`apiKey` runs agy on a Gemini API key. agy only does that when `settings.json` says `"modelProvider": "gemini"`, and it reads that file from the home folder: there is no flag, no environment variable and no project-level file for it. To leave the user's settings and login alone, an API-key run gets its own home folder, `~/.cache/cli-funnel/workspaces/antigravity-api-key/`, whose `.gemini/antigravity-cli/settings.json` holds only that setting. The run's environment has `GEMINI_API_KEY=<key>`, and `HOME` and `USERPROFILE` point at that folder. The key is never an argument, an event or a file.

Verified on 1.4.7 with an invalid key: the run starts in the private home without a sign-in and fails with `API key not valid` from `generativelanguage.googleapis.com`, and the user's `settings.json` is unchanged. A run with a valid key is covered by a test that runs when `CLI_FUNNEL_TEST_GEMINI_KEY` is set.

- The `session` event and `result.auth` say `api-key`. Runs without a key leave `auth` out, because cli-funnel cannot tell whether the user's own settings put agy on a key.
- Because `HOME` changes, the agent does not see the user's `~/.gemini` (skills, rules, global MCP servers) or dotfiles such as `.gitconfig` and `.ssh`. Shell commands the agent runs get the same home. `input.env` can restore what a task needs, for example `GIT_CONFIG_GLOBAL`.
- The folder also holds the conversations of these runs, so an API-key conversation resumes only in an API-key run.
- The model list differs: with a key agy offers the Gemini models the API serves (for example `gemini-4-argon`), not the Claude and GPT-OSS models of the account. `models()` lists the account's models.
- The key is in the environment of the agent's shell commands. A model that runs `env` can see it.
- The Windows side (`USERPROFILE`) has not been run.

## Questions and approvals

Not supported, so `capabilities.questions` is off and `onQuestion` is never called.

- agy has an `ask_question` tool. In print mode it is skipped: on 1.4.7 the stream has a step with `step_type: "unknown"` and no text, and the agent answers "You skipped answering the question." The changelog says headless runs skip subagent questions too.
- `--input-format stream-json` reads prompts only (agy 1.1.15: "newline-delimited JSON prompts from stdin and runs one turn per message"). There is no message type for an answer.
- Approval replies (`approvals`, `approvalInput`) do not apply, see [Access](#access).

## Models

`models()` runs `agy models` and merges the result with `data/models/antigravity.json`, which is the offline fallback.

`agy` bakes effort into ids such as `gemini-3.8-flash-high`. cli-funnel groups these into one model per base id (`gemini-3.8-flash`) with `efforts` `low`, `medium`, `high`. Ids without variants stay as they are: `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. Those take no effort.

The `--model` string is the base id plus `--effort <effort>`. Passing a full id together with `--effort` fails with a conflict error, and a base id with no effort fails with "requires --effort". When the selection has no effort, cli-funnel uses the model's default effort (`high` when offered). Gemini 3.1 Pro accepts only `low` and `high`.

## Login

`agy` has no login subcommand. Sign-in happens in the interactive `agy` screen, and agy stores the credentials in the OS keyring (macOS Keychain, Windows Credential Manager, Secret Service on Linux). It writes a token file under `~/.gemini/antigravity-cli/` only when the keyring is unavailable. Running on a Gemini API key instead (API billing) needs `"modelProvider": "gemini"` in `settings.json` as well as `GEMINI_API_KEY`: the variable alone changes nothing. `authStatus()` reports `Gemini API key` only when both are set. See [API key](#api-key) for how a run with `apiKey` does this without touching your settings.

`authStatus()` runs `agy models`. Exit code 0 with at least one model means signed in, whether the token is in the keyring or in the file, so cli-funnel does not look for the file. A failure that asks you to sign in means signed out. Any other failure (a timeout, a crash, an empty list) also returns `loggedIn: false`, but `detail` says what went wrong instead of asking for a sign-in. Checks never overlap: a call that arrives while one is running shares its result. It does not read the token and does not spend quota.

`login()` emits `needs-terminal` with command `["agy"]`, then polls `authStatus()` every three seconds for up to ten minutes and emits `done` once signed in.

## Logout and update

`logout()` throws an `unsupported` error. `agy` has no sign-out command. Sign out from the interactive screen.

`update()` runs `agy update`.

## Limits

- Resume uses `--conversation <id>` with the `sessionId` from the earlier run. The whole history is replayed, so long conversations start slowly.
- Tool steps carry the input parameters. Only shell commands carry output text. The step is sent after the tool has run, not before.
- Usage has no cost figure. It reports input, output, cached and thinking tokens.
- Quota errors from the model API end the run with an error result. Long server retry delays are not retried.
