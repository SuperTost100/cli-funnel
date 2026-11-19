# Antigravity

Provider id `antigravity`. Binary `agy`. Tested against 1.2.11 through 1.3.0, 1.4.6 to 1.4.7 and 1.5.12, minimum 1.2.0. The default transport needs 1.5.0 or newer. The file changes, plans, MCP servers and API key sections below were checked on 1.4.6 and 1.4.7, and the file changes and plans again over ACP on 1.5.12.

## Transports

`providerOptions.antigravity.transport` picks how cli-funnel drives `agy`:

| Transport | Starts | Needs |
| --- | --- | --- |
| `acp` (default) | `agy acp`, the [Agent Client Protocol](https://agentclientprotocol.com) server, one process per conversation | agy 1.5.0 or newer |
| `print` | one `agy --print` process per turn, as 0.9.x did | agy 1.2.0 or newer |

`acp` is the transport Google offers to other apps. See [Terms and limits](../tos-notes.md#antigravity). It gives a conversation that continues in one process, the model and thinking levels the account has, a slot for the system prompt, images, and per-turn token counts. `print` stays for older agy builds, for the subagent options and for runs on an API key, which `acp` does not take (see [API key](#api-key)). A run with `apiKey` and no `transport` uses `print`. `detect()` says in `detail` when the installed agy is older than 1.5.0, and an ACP run on such a build fails with `unsupported` and names `print`.

### How the ACP transport runs

Each run, or each live session, starts `agy acp` in the run's folder (the folder `none` owns, or `selection.cwd`) and speaks JSON-RPC over its stdin and stdout:

1. `initialize` with client capabilities that grant nothing: no file reads, no file writes, no terminal. agy reads and writes files and runs commands itself, and advertising writes would swap its own diff edits for whole-file client edits.
2. `session/new`, or `session/resume` with the stored id when the run has a `sessionId` (`session/load` when the agent advertises only that). A conversation agy does not have ends the run with `cli-failed` and "Conversation `<id>` was not found.", with no `session` event.
3. The model and the thinking level, set with `session/set_config_option` from the `model` and `thought_level` options of the session. They are set again on every activation, because a resumed session answers with the account's default. A model the account does not list fails with `invalid-selection` and names the models it does list.
4. `system` goes in `_meta.antigravity.systemPrompt.append` when the agent advertises that slot, which 1.5.12 does. It is sent again on every activation, because agy keeps none of it between processes. Without the slot the system prompt goes in front of the prompt, as in `print`.
5. `session/prompt`. Text arrives as `session/update` notifications: `agent_message_chunk` as `text.delta`, `agent_thought_chunk` as `reasoning.delta`, tool calls as `tool.start` and `tool.end`, and `plan` as `plan`. The answer of the prompt carries the stop reason and the token counts.

`session/cancel` ends a turn when the caller aborts or `printTimeoutSec` passes. agy answers the prompt with `cancelled`, and the process stays up for the next turn of a live session. If it does not answer within five seconds, cli-funnel ends the turn and stops the process.

Verbose runs send every line agy prints on stdout, and its stderr, as `raw` events.

### Sessions

`sessionId` in and out works as on the other CLIs. A one-shot run starts a process, runs one prompt and stops it. With `sessions.keepAlive` the process stays up between turns of the same conversation, so a second turn needs no start and no `session/resume`. After the process is gone, the next turn resumes by id on a new one. Checked on 1.5.12: a word told to the first process was remembered by the second after a resume, and by the same process on the next turn. Settings that cannot change mid-process (model, level, system prompt, access, folder) start a new process, as the [live session rules](../sessions.md#when-a-turn-reuses-a-process) say. `steer` is not available.

### What the account lists

`models()` still runs `agy models` and merges it with the bundled list, because a session per call would add a conversation to the account's history each time. Every ACP session also reports the account's models, and cli-funnel merges those into the list it uses for default efforts. On 1.5.12 the two lists were identical. Besides `low`, `medium` and `high`, some models have an `xhigh` level, shown as "XHigh", and the levels a model offers are the ones its session lists: `gemini-3.8-flash` has three and `gemini-4-neon` has four.

### What `print` does and ACP does not

- No `--json-schema`: ACP has no schema field, so `responseSchema` is asked for in the prompt, `capabilities.schema` is `"prompt"`, and cli-funnel parses the answer. Use `print` when the vendor should enforce the schema.
- `forwardSubagentText` and `forwardSubagentTools` read the print transport's output and are refused with `unsupported` over ACP.
- `access.reduced` is not reported at `full`: a session started with `--dangerously-skip-permissions` still reports mode `default`, so the funnel cannot tell.
- `rateLimits()` still runs `agy --print=/usage`, which starts no model turn.

## Warnings

On the `print` transport, `agy` prints warnings on stderr as lines that start with `warning:` and a space, for example `warning: --mode plan has no effect while slash command expansion is disabled.` or `warning: ignoring unsupported stream input message event "bogus"`. Each one becomes a `warning` event with the rest of the line as its message, and `RunResult.warnings` lists them in order. Lines with other prefixes (`error:`, `jetski:`, `[agy]`, `AGY_ERROR:`) are not warnings and are handled as before. Checked on 1.5.3. Over ACP, stderr holds agy's own log lines, which are not warnings and show only as `raw` events.

Stderr is a separate pipe from the stream, so a warning can be read before or after the `init` line that produced `session`. Warnings are therefore held until `session` (and `access.reduced`, when there is one) has gone out, and are emitted right after them. A warning that arrives later goes out before the next event. If the run ends without a `session` event, the held warnings come just before the `done` or `error`. Before the `done` or `error` goes out, cli-funnel waits for `agy` to exit, so the last stderr line is read, and stops a process that is still running after one second. Warnings are masked with the run's secrets, as `raw` events are.

## Capabilities

| Feature | Supported |
| --- | --- |
| Access levels | `none`, `accept-edits`, `full` |
| Effort | yes, the levels each model lists |
| Context window | no |
| Fast mode | no |
| Resume | yes, with `sessions.keepAlive` on the same process |
| Approvals | no |
| Images | yes over ACP, refused on `print` |
| System prompt | the session's slot over ACP, in front of the prompt on `print` |
| JSON schema | asked for in the prompt over ACP, `--json-schema` on `print` |
| File changes | yes, from the file tools and a plain `rm` |
| Plans | yes, when the agent keeps a `task.md` |
| MCP servers | `http` and `stdio`, at `full` on both transports and at `none` over ACP off Windows, where they are the model's only tools |
| API key | yes, on `print` only |
| Questions | no |
| Sandbox | no |

## Access

`supervised` is not available. In print mode `agy` cannot ask anyone for permission, and over ACP cli-funnel does not forward the permission requests `agy` sends yet: it denies each one. A tool that needs a permission is denied on the spot and listed in `denied_actions`, and the run continues without it. There is no request to forward, so cli-funnel cannot offer an approve button.

- `accept-edits` passes `--mode accept-edits` on `print`, and sets the session mode `accept-edits` over ACP. Every permission request that is left, such as one for a shell command, is denied and the call shows as `denied:`. Verified: file writes succeed in a workspace the user has already trusted in Antigravity (listed in `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`). In an untrusted directory such as a fresh `/tmp` folder the write is still denied. Trust the folder once in the interactive `agy` first.
- `full` passes `--dangerously-skip-permissions` on both transports. Every tool runs without a check. Verified over ACP on 1.5.12: a file write and a shell command ran with no request.
- `auto` is not offered. `agy` 1.3.5 added `--mode auto`, but it is not available on every account. On an account without it, `agy` prints `warning: --mode auto is not available for this account; continuing in the default mode.` on stderr and runs in the default mode. cli-funnel cannot tell from the stream which mode ran, so it cannot promise the level. Tested on 1.3.5.

On `print`, at `full`, `init` reports `permission_mode: "always-proceed"`. When it reports anything else, the run emits `access.reduced` after `session`. The default mode and `--mode accept-edits` both report `request-review`, so `accept-edits` cannot be checked. See [Access levels](../access-levels.md#when-the-cli-starts-with-less-access).

That is not true of every shell command. On 1.2.13, a `touch` outside the workspace ran without a check both in the default print mode and with `--mode plan --sandbox`. `--mode plan` has no effect together with `--disable-slash-commands`, and the CLI prints a warning saying so. Neither mode can carry `none`.

### Sandbox

`sandbox: true` is refused with `unsupported`. On 1.4.7 a run with `--dangerously-skip-permissions --sandbox` wrote `../outside.txt` from a shell command, and the stream showed no sandbox error. With `--mode accept-edits --sandbox` the command was denied, but by the permission check, which also denies commands inside the workspace. It is not known whether agy's sandbox failed to start on that host or does not cover writes. Either way agy reported nothing, so cli-funnel cannot tell a confined run from an unconfined one.

### `none`

`agy` loads `.agents/hooks.json` from the folder it runs in, on both transports. A `PreToolUse` hook that answers `{"decision": "deny"}` blocks the call before any permission check. At `none` the provider runs `agy` with no mode flag in `~/.cache/cli-funnel/workspaces/antigravity-none/`, which holds only that hook file. The hook command is `cat >/dev/null; printf '%s\n' '<deny json>'` (`echo <deny json>` on Windows).

The matcher covers every tool name except `finish`. `finish` ends the turn and carries the `--json-schema` answer, and denying it breaks structured output. Go regexp has no lookahead, so the matcher spells the exclusion out.

Verified on 1.3.0:

- `run_command`, `write_to_file`, `view_file`, `call_mcp_tool` and `invoke_subagent` fail with "tool call denied by pre-tool hook". Nothing is written.
- Hooks that answer `allow`, before or after this one, do not override the deny.
- A hook that exits non-zero also blocks the call, so a broken hook fails closed.
- `--json-schema` still returns `structured_output`. Resume works, because every `none` run uses the same folder.

The model sees its full tool list, so the input token count is the same as at other levels. The Windows hook command has not been run on Windows.

**The user's own setup, over ACP.** `agy` reads the user's MCP servers (`~/.gemini/config/mcp_config.json`), skills and global `GEMINI.md` from its Gemini folder, and it starts those servers when a session opens, before any prompt. So at `none` the ACP transport starts `agy acp --gemini-dir=<cache>/workspaces/antigravity-gemini-none`, a folder that holds only a link (a junction on Windows) to the user's `antigravity-cli` data folder. The sign-in and the conversations are reached through the link, so `sessionId` resumes across levels. Checked on 1.5.12 without a model call, in a home folder made for the test (its data folder linked to the real one): a stdio server in that home's `mcp_config.json` wrote its marker line when `agy acp` started the normal way, and wrote nothing with `--gemini-dir`, and the session and its models still came back. A live `none` run through cli-funnel then answered and the marker file stayed empty (`test/antigravity-none-live.test.ts`). The skills and the global `GEMINI.md` are out of the run too. The private folder is made inert before `agy` first sees it. `agy` migrates a Gemini folder it finds without `config/.migrated` on its first start, and through the link that migration moved and re-pointed the user's own `antigravity-cli/skills` folder (found in the first round of experiments and repaired by hand). So cli-funnel writes `config/.migrated`, an empty `config/skills` folder and an empty `config/mcp_config.json` into the private folder first, and replaces a `config/skills` that is a link with an empty folder. Tested without a model call, in a home folder made for the test, with the user's `skills` as a real folder with a file in it and as a link to `~/.gemini/config/skills`: after `initialize` and `session/new` at `none` both were unchanged and nothing from them was loaded. The user's `antigravity-cli` folder is created when it is missing, so the link always has a target and two runs that start together cannot end up with conversations in a folder a later run would remove. The link is compared with `realpath`, and nothing is ever removed with a recursive delete: a stale link goes with `unlink`, a real folder in the link's place is renamed to `antigravity-cli.kept-<time>`. On a machine whose sign-in sits in the OS keyring this was not tried: the flag does not change the keyring, but a run that fails to find the sign-in would show up as `not-logged-in`.

**The print transport cannot do that.** `agy --print` has no `--gemini-dir`, and `--settings` knows only a few keys, none of which lists MCP servers (it answers `unknown setting` for every MCP name tried: `mcpServers`, `mcp`, `mcpEnabled`, `enableMcp`, `disableMcp`, `allowedMcpServers`). In a `print` run at `none` the user's MCP servers still start, and the hook refuses every call to them. A private `HOME` would hide them, but it would also hide an OS keyring sign-in, so cli-funnel does not do it. Use ACP when that matters.

**A repository above the folder.** `agy` finds the repository root and loads `AGENTS.md`, `GEMINI.md` and `.agents/` from every folder between the working folder and it, so a user whose home folder is a git repository had their instructions read in a `none` run. The run's folder is now the root of its own repository: it holds a `.git` with a `HEAD`, an `objects` folder and a `refs` folder, which is what makes `git rev-parse --show-toplevel` answer with the folder itself. Checked on 1.5.12 (`gemini-3.8-flash`) with `AGENTS.md` that says "end every reply with ZEBRA" in a real repository above the folder: the reply ended in ZEBRA when the folder had no root of its own and when it held an empty `.git` folder, and did not with `git init` or with the hand-made marker. An empty `.git` folder is not enough. `.agents/` was not tried separately, since the walk is the same one. Both transports use this folder. Cursor Agent does not stop at the marker: see [the Cursor Agent page](agent.md#how-none-works). `GIT_DIR` and `GIT_WORK_TREE` are taken out of the environment of a `none` run, since they would point git at another repository whatever the folder holds.

Over ACP the session also grants the agent nothing on the client side and denies every permission request, so a second layer stands behind the hook. Verified live on 1.5.12 with `gemini-3.8-flash`: asked to read a file outside the folder and to run `touch` on a marker file, the model got `tool call denied by pre-tool hook` for both, the marker was not created and the file's content never reached the answer. Without the hook the same read ran with no permission request at all, so the hook is what enforces `none`, and `agy` does not ask before a read.

Denied tools appear as `tool.end` events whose error starts with `denied:`. Over ACP a tool that failed at `none` has no text, so it is reported as the hook's denial. That includes calls refused by a hook, which `agy` does not list in `denied_actions`. If the run produced no text and something was denied, the finish reason is `denied`.

**A second line behind the hook.** At `none` the funnel watches the tool calls. A call that ends without an error, a call that fails with a message that is neither the hook's denial nor our permission refusal, and a forbidden call that started and never ended by the end of the turn each stop the run with a `cli-failed` error. Only `finish` is allowed to complete. The limit: over ACP a failed call comes without text, and the funnel writes the hook's denial for it, so a call that failed for another reason without text counts as refused.

## Folder config

`folderConfig` is refused with `unsupported` for `ignore` and `instructions`, and `capabilities.folderConfig` is empty. agy has no flag or setting that turns the folder's config off. Its built-in documentation says it walks from the working folder up to the repository root and loads the `.agents/` folder it finds there (rules, skills, workflows, plugins), plus `GEMINI.md` and `AGENTS.md`.

Checked on 1.5.9 with `gemini-3.8-flash` at effort `low`, in the root of a git repository:

| What the folder carries | What happened |
| --- | --- |
| `.agents/hooks.json`: a `PreToolUse` hook that answers `allow` | the hook ran on the shell call. Its `allow` did not get the call past the denial of print mode |
| `.agents/plugins/<name>/mcp_config.json`: a stdio server | started, with no approval |
| `AGENTS.md`, `GEMINI.md` and an `always_on` rule in `.agents/rules/` | all loaded |

Running agy in an empty folder with the project added through `--add-dir` would not help: agy loads `.agents/plugins` from added folders too, which is how cli-funnel attaches MCP servers (see [MCP servers](#mcp-servers)).

## Run options

Over ACP, `system` goes in the session's system prompt slot, `attachments` go as image content blocks (checked with a PNG on 1.5.12), and `responseSchema` is asked for in the prompt: the schema follows the question in a short instruction, and cli-funnel parses the reply, with or without a code fence. A reply that is not JSON leaves `structured` empty and sets `structuredError`.

On `print` the CLI has no system prompt flag, so `system` goes in front of the prompt inside `<instructions>`. `responseSchema` goes to `--json-schema`, as a path to a private temp file when the schema is over 4 KB (removed after the run), and the `result` event carries the parsed answer in `structured_output`. Images are refused.

## Provider options

`providerOptions.antigravity`, checked against 1.3.6 and 1.5.12 and run live:

| Option | Flag | Access levels |
| --- | --- | --- |
| `transport: "acp" \| "print"` | `agy acp`, or `--print` | all |
| `addDirs: string[]` | `--add-dir=<dir>`, absolute paths | `accept-edits`, `full` |
| `printTimeoutSec: number` | `--print-timeout=<n>s` on `print`, a `session/cancel` after that long on `acp` | all |
| `forwardSubagentText: boolean` | none, read from the subagent's transcript. `print` only | all |
| `forwardSubagentTools: boolean` | none, read from the subagent's transcript. `print` only | all |

At `none` the run happens in a folder that holds only the deny hook, so `addDirs` is refused there.

## File changes

Each finished file write becomes a `file.change` event after its `tool.end`, with the absolute path and the status `done`, `failed` or `declined` (a hook or the permission check refused it). The file system is never asked about a `declined` write, so the event does not tell the caller whether a path the model chose exists on the host: a declined write is an `add`, unless this run already wrote that file, which makes it an `update`.

| What the agent does | `kind` |
| --- | --- |
| `write_file` (`write_to_file` before 1.4) to a file the run created | `add` |
| `write_file` to a file that was there before the run, or a second write to a file in the same run | `update` |
| `edit_file` (`replace_file_content`, `multi_replace_file_content` before 1.4) | `update` |
| `run_command` that is a plain `rm`, for example `rm -rf a b` | `delete`, one event per path |

- agy sends a tool step only after the tool has run, so "did the file exist" cannot be checked when the step arrives. `add` versus `update` comes from the file's creation time: created at or after the start of the run (with a second of slack) is an `add`. Where the file system reports no creation time, or the file is gone, a `write_file` counts as an `add`. At `none` the creation time is never read, so a run that may not read files cannot learn which ones exist.
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

### Over ACP

The default transport hands the servers to `session/new` and `session/resume`: `{type: "http", name, url, headers: [{name, value}]}` for HTTP and `{name, command, args, env: [{name, value}]}` for stdio. They go over the pipe, so a token is on no disk. Access is `none` and `full`. `accept-edits` is refused, because agy asks about every MCP call there and nobody can answer.

**Reserved names.** agy names tools by server, `mcp_<server>_<tool>`, and a plugin's server `<plugin>_<server>`, and the user's own servers have names too. A caller's `notes` could equal a user's `notes`, and any fixed name could be taken beforehand by a user's server or plugin. So each server goes to agy as `clifunnel<run>_<n>`, where `<run>` is 8 random hex digits made for this one run and `<n>` is the server's position in `mcpServers`. Nothing that exists beforehand can have such a name, every comparison is exact, and the events map the name back: `tool.start` shows `mcp_<your name>_<tool>` and carries `mcp: { server, tool }`. A caller server whose name starts with `clifunnel` is refused with `invalid-selection`. Only the mapper tags a call on this transport: the funnel's reading by display name is off, so a user's server that has your name is not reported as yours. A resumed conversation gets new names with its new process, and re-sends the servers under them.

**The hook is a fixed deny and runs no script.** At `none` the run's folder, `antigravity-none[.<name>].run.<id>` (removed when the process ends), holds `.agents/hooks.json` and the git marker. The hook command is the same shell line the `none` hook of a run with no servers uses, `cat >/dev/null; printf` of the deny answer (`echo` on Windows), so it needs no Node and no copy of the host app. A first design ran a Node script. Under a packaged Electron app with the RunAsNode fuse off that command starts a second copy of the app, which exits 0 with nothing on stdout, and agy reads that as allow, so every tool would have been open. A script that needs a Node binary is the wrong shape for that host.

What a hook matcher can say: it is a Go regular expression (no lookahead) tested against the tool's name, and nothing in the tool's arguments. "Everything except these" has to be spelled out, and `exceptNames` does it as a trie over names and prefixes: the matcher matches every name but `finish` and every name that starts with `mcp_clifunnel<run>_`, so the hook denies those it matches. `call_mcp_tool` is not left out, since it names its server in its arguments, which the matcher cannot see: it is denied for every server, the run's own included, and the model reaches the run's servers by their tool names. The deny answer says so (`Call those by their own names, which start with mcp_, not through call_mcp_tool`). It holds no `<`, `>`, `&`, `|`, `^` or `%`: on Windows the hook is an `echo` of it, and the hook self-test on a Windows runner refused it when it said `mcp_<server>_<tool>`. The client then answers each `session/request_permission` the same way, allowing only a tool of this run's names, and a run is stopped with an error if any other tool finishes at `none`. The guard decides at the end of a call, with the arguments of its last update, because a call can name its server in a later update than its first.

**The hook is tested before the run starts.** When the folder is ready, cli-funnel runs the exact hook command through the shell the way agy will, with a refused call on stdin, and starts nothing unless the output is the deny answer (`unsupported`, "would read it as allow"). It does this for the fixed hook of a run with no servers too, once per process per command. A test puts a `sh` that exits 0 with no output first on the PATH, the packaged-app case, and sees the run refused with no process started. The Windows form of the command (`cmd /d /s /c`) has not been run on Windows.

Verified live on 1.5.12, with `agy acp` driven by a raw client that **allowed every permission request**, so that the hook was the only thing between the model and the other servers (`gemini-3.8-flash`, low effort, access `none`, the run's own folder and a private `--gemini-dir`):

- **Generic route.** A plugin `usersim` in the run's folder gave agy a second server, set up the way a user's would be, next to the caller's server under `clifunnel5ec0de01_0`. The prompt asked for a note on each, the second through `call_mcp_tool` with `ServerName: "usersim_other"`. The caller's note was recorded, the `call_mcp_tool` call ended `failed`, and the other server recorded nothing. agy asked for permission only for the caller's tool, so the hook refused the other call before the permission check. That the plugin server can be called when nothing stops it was shown earlier at `full` on the same agy (it recorded the note).
- **Direct route.** A second server `usersim2` given to the session next to the caller's. The prompt asked for a note on each, the second by the tool name `mcp_usersim2_add_note`. The caller's note was recorded, the call to `mcp_usersim2_add_note` ended `failed`, and that server recorded nothing.
- `test/antigravity-mcp-live.test.ts` repeats both.

**How the model reaches the caller's tool** (funnel runs at `none`, one caller HTTP server with `add_note`, three prompts each):

| Prompt | `gemini-3.8-flash` | `gemini-4-neon` |
| --- | --- | --- |
| "Save a note that says hello-from-the-model" | called `mcp_notes_add_note`, note saved | the same |
| "Call the add_note tool of the MCP server named notes" | the same | the same |
| "Use the generic call_mcp_tool tool to call add_note" | tried a shell command (denied), then called the tool by its own name, note saved | answered that `call_mcp_tool` is not available, called nothing, saved no note, and the run finished normally |

So a prompt written the natural way reaches the tool directly on both models, and one that demands the generic route is not honored by the second. Do not tell the model to use `call_mcp_tool`. Where cli-funnel's own wording is not enough, name the server's tool in the prompt.

Caveats seen on 1.5.12:

- agy sends `server/discover` before `initialize`. A server must answer an unknown method with a JSON-RPC error (`-32601`). A server that answers `202` with no body fails to load (`unsupported content type`), and a stdio server that ignores the request makes the call hang.
- Over HTTP the `Authorization` header is on every `POST`, but not on the `GET` that opens the event stream.
- The model discovers servers by looking, for example `ls ~/.gemini/antigravity-cli/mcp`, which `none` refuses, so name the server in the prompt.
- `toolTimeoutSec` is refused with `unsupported`: the ACP server has no such field. The `print` transport has one.
- **A server at `none` should not read or write files in the run's folder.** A stdio server starts in that folder, because the ACP server entry has no `cwd` field (and no timeout), and the folder holds the hook file `.agents/hooks.json`. A server that rewrote it could take the hook away for the rest of the turn. cli-funnel puts the folder and the hook back before every turn, and marks the folder as in use so another process's sweep leaves it, but it cannot stop a server inside a turn. If your server needs a working folder of its own, have its command change into it first.
- **Not on Windows.** MCP servers at `none` are refused there with `unsupported`, until a live run on Windows shows the hook denying other tools. The hook's command is a `cmd.exe` line that has not been run on Windows. `capabilities.mcpServersAtNone` still lists both types, since it does not vary by platform: check the platform too.
- The `print` transport refuses `none` with servers. It reports a server as `funnel_<name>` in `call_mcp_tool`, and the events map that back too.

### Over `print`

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

`apiKey` runs agy on a Gemini API key, on the `print` transport. A run with `apiKey` and `transport: "acp"` fails with `unsupported`: the ACP sign-in methods were not tried with a key.

agy runs on a key only when `settings.json` says `"modelProvider": "gemini"`, and it reads that file from the home folder: there is no flag, no environment variable and no project-level file for it. To leave the user's settings and login alone, an API-key run gets its own home folder, `~/.cache/cli-funnel/workspaces/antigravity-api-key/`, whose `.gemini/antigravity-cli/settings.json` holds only that setting. The run's environment has `GEMINI_API_KEY=<key>`, and `HOME` and `USERPROFILE` point at that folder. The key is never an argument, an event or a file.

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

`models()` runs `agy models` and merges the result with `data/models/antigravity.json`, which is the offline fallback. See [What the account lists](#what-the-account-lists) for the ACP side.

`agy` bakes effort into ids such as `gemini-3.8-flash-high`. cli-funnel groups these into one model per base id (`gemini-3.8-flash`) with the efforts the ids carry: `low`, `medium`, `high`, and `xhigh` where there is one. Ids without variants stay as they are: `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. Those take no effort.

On `print` the `--model` string is the base id plus `--effort <effort>`. Over ACP the base id goes to the session's `model` option and the effort to its `thought_level` option, and an id with the level in it (`gemini-3.8-flash-high`) is read as the base id and a level. Passing a full id together with `--effort` fails with a conflict error, and a base id with no effort fails with "requires --effort". When the selection has no effort, cli-funnel uses the model's default effort (`high` when offered). Gemini 3.1 Pro accepts only `low` and `high`.

## Login

`agy` has no login subcommand. Sign-in happens in the interactive `agy` screen, and agy stores the credentials in the OS keyring (macOS Keychain, Windows Credential Manager, Secret Service on Linux). It writes a token file under `~/.gemini/antigravity-cli/` only when the keyring is unavailable. Running on a Gemini API key instead (API billing) needs `"modelProvider": "gemini"` in `settings.json` as well as `GEMINI_API_KEY`: the variable alone changes nothing. `authStatus()` reports `Gemini API key` only when both are set. See [API key](#api-key) for how a run with `apiKey` does this without touching your settings.

`authStatus()` runs `agy models`. Exit code 0 with at least one model means signed in, whether the token is in the keyring or in the file, so cli-funnel does not look for the file. A failure that asks you to sign in means signed out. Any other failure (a timeout, a crash, an empty list) also returns `loggedIn: false`, but `detail` says what went wrong instead of asking for a sign-in. Checks never overlap: a call that arrives while one is running shares its result. It does not read the token and does not spend quota.

`login()` emits `needs-terminal` with command `["agy"]`, then polls `authStatus()` every three seconds for up to ten minutes and emits `done` once signed in.

## Usage limits

`funnel.rateLimits("antigravity")` runs `agy --print=/usage --output-format stream-json` and reads its `command_result` line. The command runs no model turn and spends no quota. It runs in the folder that `none` uses, so it never touches your project, and it times out after 30 seconds. `env` and `signal` from the options apply to the process. Checked on 1.5.3.

The account has several model groups, such as "Gemini Models" and "Claude and GPT models", and each group has its own 5-hour and weekly limit. Some groups have only a weekly limit. The result has one entry in `groups` per group, and for each window:

| Field | Value |
| --- | --- |
| `primary` | the group's `5h` bucket, `windowMinutes: 300` |
| `secondary` | the group's `weekly` bucket, `windowMinutes: 10080` |
| `usedPercent` | `(1 - remaining_fraction) * 100`, rounded to one decimal |
| `resetsAt` | the bucket's `reset_time`, as an ISO 8601 timestamp |

The top-level `primary` and `secondary` hold the fullest window of each kind across the groups. `plan` is not set, because the output does not name one.

A full group stops only its own models, so `limit` is set only when every group has a full window. It is a `rate` limit when the window that holds the first group back is the 5-hour one, and a `quota` limit when it is the weekly one, and `resetAt` is when that group is back. A group with two full windows is back when both have reset.

Errors: `not-installed` when `agy` is missing, `not-logged-in` when the output asks for a sign-in (not tested, because that needs a signed-out account), `unsupported` when the output has no `usage` result, as on an older `agy`, or when the `result` reports an error, `aborted` when `signal` was aborted, and `cli-failed` for a timeout or any other failure.

`test/fixtures/antigravity/usage.ndjson` is the recorded output.

## Logout and update

`logout()` throws an `unsupported` error. `agy` has no sign-out command. Sign out from the interactive screen.

`update()` runs `agy update`.

## Subagents

The agent starts a subagent with `invoke_subagent`. It shows as a `tool.start` and `tool.end` named `invoke_subagent`. The step starts as a `tool` step and ends as a `subagent` step, and the `tool.end` output lists the subagents it started, each with its `type`, `role`, `prompt` and `conversationId`.

The subagent works in a conversation of its own, and its steps are not in the stream. agy writes them to `<brain>/<conversation id>/.system_generated/logs/transcript.jsonl`, where `<brain>` is `~/.gemini/antigravity-cli/brain` in the home folder the run uses (the API-key home when the run has `apiKey`). With `forwardSubagentTools` or `forwardSubagentText`, cli-funnel reads that one file:

1. The `subagent` step that ends `invoke_subagent` names the subagent's conversation id. Only an id of letters, digits and dashes is used, and no other file in the brain folder is read.
2. The file is read every 500 ms while the run goes on, from where the last read stopped.
3. Before the run's `done` or `error`, it is read once more, including a last line without a line break.

| Transcript step | What cli-funnel emits |
| --- | --- |
| `PLANNER_RESPONSE` with `tool_calls` | one `tool.start` per call, with `forwardSubagentTools`. The calls have no ids, so each gets `<conversation id>:<step>:<n>` |
| the `GENERIC` step after a call | its `tool.end`, with the step's `content` as the output, in call order |
| `PLANNER_RESPONSE` with `content` | `subagent.text`, with `forwardSubagentText` |
| `SYSTEM_MESSAGE` (the prompt), other types, lines that are not JSON | nothing |

Every event carries `parentId`, the id of the `invoke_subagent` call, and `agent`, the subagent's `type_name` (such as `self`). Tool arguments in the transcript are JSON written as strings, and they are decoded. A missing or unreadable file gives no events and does not fail the run. A subagent that is still working when the run ends leaves its last calls without a `tool.end`. The events are not part of `result.toolCalls`, and the run's secrets are masked in them.

This follows agy 1.4.12, which documents none of it. `scripts/check-drift.mjs` checks that the agy binary still contains `.system_generated`, `transcript.jsonl`, `PLANNER_RESPONSE` and `brain`. `test/fixtures/antigravity/subagent.ndjson` is a recorded run with paths replaced and the tool list cut, and `subagent-transcript.jsonl` is that subagent's transcript, with paths and user names replaced.

## Limits

On `print`:

- Resume uses `--conversation <id>` with the `sessionId` from the earlier run. The whole history is replayed, so long conversations start slowly.
- A resume of a conversation `agy` does not know does not fail in `agy`. It prints `warning: conversation "<id>" not found` on stderr and runs the prompt in a new conversation. A resume that works reports the same id in `init.conversation_id`, and a new conversation reports a different one (checked on 1.5.3). When the id differs from the requested `sessionId`, cli-funnel stops the process and ends the run with an `error` event (code `cli-failed`) that says the conversation was not found and that `agy` started a new one. It sends no `session` event for the new conversation, so the caller does not store its id. The `warning` event comes before the error.
- Tool steps carry the input parameters. Only shell commands carry output text. The step is sent after the tool has run, not before.
- Usage has no cost figure. It reports input, output, cached and thinking tokens. `agy --print` adds up the tokens of the whole conversation, so a resumed run reports the earlier turns too (a second turn showed `num_turns: 2`). ACP reports the tokens of the prompt alone.
- Quota errors from the model API end the run with an error result. Long server retry delays are not retried.

## Usage and limits over ACP

`usage` follows the contract of every provider: `inputTokens` holds the cached part, and `cachedInputTokens` says how much of it came from the cache. agy leaves the cache out of its own `input_tokens` and `inputTokens`, so cli-funnel adds `cache_read_tokens` (or `cachedReadTokens`, `cachedWriteTokens`) back. A second turn of a recorded conversation said 3,571 input and 16,605 cached, which is `inputTokens: 20176` here.

Cost of the prompt "Reply with the single word OK." at access `none` on `gemini-3.8-flash` at effort `low`, measured on 1.5.12: 17,994 input tokens over ACP, 17,998 on `print`. About 18,000 tokens are agy's own tool list and instructions. In the same live ACP session a second turn of the same prompt took 18,063 input tokens, of which 15,940 (88 percent) were served from the cache.

A quota or rate limit comes from a JSON-RPC error of the prompt, or from the `refusal` stop reason, which agy uses only for an exhausted quota. The error text carries Google's own fields (`RESOURCE_EXHAUSTED`, `429`, `QUOTA_EXHAUSTED`), and the run emits a `limit` event, then an `error`. `resetAt` comes from `quotaResetTimeStamp`, else from the delay in `quotaResetDelay` or `retryDelay`. A limit with a wait of more than five hours, or one that names a quota, is `quota`, and any other is `rate`. `SUBSCRIPTION_REQUIRED` ends the run with `cli-failed` and says so. A sign-in error ends it with `not-logged-in`, and cli-funnel never starts a sign-in itself.

These readings follow T3 Code's handling of agy, not a recorded failure, because the account used for testing had quota left. `agy` can also report an upstream API failure as a chat message that ends the turn normally. cli-funnel reads a reply that holds the harness's wording, `Error 429, Message: ..., Status: RESOURCE_EXHAUSTED`, as that failure. A quota error worded differently arrives as ordinary text.
