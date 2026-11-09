# Access levels

Access says how much the agent may do on the machine. cli-funnel has four levels and one rule. A provider lists a level only if the CLI can enforce it when it runs headless.

| Level | Meaning |
|---|---|
| `none` | Text in, text out. No writes, no commands, no MCP servers, no approvals. See [Run options](run-options.md). |
| `supervised` | Every risky action waits for a human. Your `onApproval` callback gets the request. |
| `accept-edits` | File edits go through. Other actions ask, or are refused when nobody can answer. |
| `auto` | The CLI decides which actions are safe. The rest ask or are refused. |
| `full` | Nothing asks. The agent can run any command with your user's rights. |

## What each CLI can do

| | Claude Code | Codex | Cursor Agent | Antigravity |
|---|---|---|---|---|
| `none` | yes | yes | yes | yes |
| `supervised` | yes | yes | no | no |
| `accept-edits` | yes | yes | no | yes |
| `auto` | yes | yes | yes | no |
| `full` | yes | yes | yes | yes |

The picker shows only the levels a provider offers. `funnel.providers.claude.capabilities.access` gives the same list in code. Asking for a level the provider lacks throws `invalid-selection` and names the levels that exist.

## Why some are missing

`supervised` needs a way to pass an approve button through. A headless CLI has no terminal, so it either supports a control channel or it auto-denies. Two of the four support one.

Claude Code has a stdio permission channel. The CLI pauses and asks the host, and the provider answers. Codex does the same through its app-server protocol. Both are tested live: an allowed write lands on disk, a denied write does not.

Cursor Agent runs unrestricted in print mode when the user's Cursor config says so, and its ACP server never asked for permission in testing. Antigravity refuses gated tools in headless mode and lists them as denied. Neither has a channel to answer through, so `supervised` is not offered. When one of them adds one, the provider will list it.

Antigravity's `accept-edits` writes only inside workspaces the user has already trusted in `agy`.

`none` needs a mode the CLI enforces, not one the model is asked to respect. Claude Code can remove every tool. Codex runs in a read-only sandbox with its tool features off and every approval denied. Cursor Agent and Antigravity have no such flag. Their read-only modes still ran shell commands in testing. Both do read config from the folder they run in, so cli-funnel runs them in an empty folder of its own that holds a rule refusing every tool call. The CLI applies the rule, not the model. See [Run options](run-options.md#text-only-access-none).

## When the CLI starts with less access

A managed policy can leave a CLI with less access than the run asked for, and the CLI does not fail. A Codex requirements file that allows only a read-only sandbox is one case. Claude Code's `permissions.disableBypassPermissionsMode` and `permissions.disableAutoMode` are two more. Without a report, a run at `accept-edits` would get an agent that cannot write, and the caller would find out from the answer.

When the CLI says it started narrower, the run gets an `access.reduced` event right after `session`, and `result.accessReduced` holds the first one. It has `access` (the level you asked for), `expected` and `started` (the CLI's own names for the two modes), and `reason` when the CLI gives one. The run goes on with what the CLI allowed. `cli-funnel run` prints a line on stderr, also with `--quiet`.

| CLI | What is compared |
|---|---|
| Codex | The sandbox in the `thread/start` or `thread/resume` answer against the one that was sent. `reason` is the `configWarning` text about the sandbox. |
| Claude Code | `permissionMode` in `init` against the mode the level maps to, at `accept-edits`, `auto` and `full`. |
| Antigravity | `permission_mode` in `init` at `full`: anything but `always-proceed` is reported. The other levels start in the same mode whatever their flags, so they are not checked. |
| Cursor Agent | Nothing. Its `init` says `default` whatever the flags, so the funnel cannot tell. |

Codex also checks the approval policy. If it started with a policy that asks less often than the level needs, the run fails with code `cli-failed` and a message that names both policies, because at `supervised` a forced `never` would run commands without asking `onApproval`. A policy that asks more often is not reported.

## Denied actions

When a CLI refuses an action because nobody could approve it, the run reports it in `result.deniedActions`. It does not fail. Check that list, then raise the level or choose a provider with `supervised`.

## Choosing a level

Use `supervised` when a person watches the run and the project holds anything you would miss. Use `full` inside a container or a throwaway checkout. The other two sit between them. `full` on your everyday machine lets a bad prompt delete files, so treat it that way.
