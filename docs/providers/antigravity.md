# Antigravity

Provider id `antigravity`. Binary `agy`. Tested against 1.2.11 through 1.2.13, minimum 1.2.0.

Runs use `agy --print=<prompt> --output-format stream-json` with stdin closed. The stream carries an `init` event, `step_update` events (text deltas and tool steps) and a final `result` with token usage and `denied_actions`.

## Capabilities

| Feature | Supported |
| --- | --- |
| Access levels | `accept-edits`, `full` |
| Effort | yes |
| Context window | no |
| Fast mode | no |
| Resume | yes |
| Approvals | no |

## Access

`supervised` is not available. In print mode `agy` cannot ask anyone for permission. A tool that needs a permission is denied on the spot and listed in `denied_actions`, and the run continues without it. There is no request to forward, so cli-funnel cannot offer an approve button.

- `accept-edits` passes `--mode accept-edits`. Verified: file writes succeed in a workspace the user has already trusted in Antigravity (listed in `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`). In an untrusted directory such as a fresh `/tmp` folder the write is still denied. Trust the folder once in the interactive `agy` first.
- `full` passes `--dangerously-skip-permissions`. Every tool runs without a check.
- `auto` does not exist in `agy` and is not offered.

Denied tools appear as `tool.end` events whose error starts with `denied:`. If the run produced no text and something was denied, the finish reason is `denied`.

## Models

`models()` runs `agy models` and merges the result with `data/models/antigravity.json`, which is the offline fallback.

`agy` bakes effort into ids such as `gemini-3.8-flash-high`. cli-funnel groups these into one model per base id (`gemini-3.8-flash`) with `efforts` `low`, `medium`, `high`. Ids without variants stay as they are: `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. Those take no effort.

The `--model` string is the base id plus `--effort <effort>`. Passing a full id together with `--effort` fails with a conflict error, and a base id with no effort fails with "requires --effort". When the selection has no effort, cli-funnel uses the model's default effort (`high` when offered). Gemini 3.1 Pro accepts only `low` and `high`.

## Login

`agy` has no login subcommand. Sign-in happens in the interactive `agy` screen, and the credentials are stored under `~/.gemini/antigravity-cli/`. Setting `GEMINI_API_KEY` is an alternative that uses API billing instead of the subscription.

`authStatus()` checks that the token file exists (or that `GEMINI_API_KEY` is set), then runs `agy models` to confirm it works. It does not read the token and does not spend quota.

`login()` emits `needs-terminal` with command `["agy"]`, then polls `authStatus()` every two seconds for up to ten minutes and emits `done` once signed in.

## Logout and update

`logout()` throws an `unsupported` error. `agy` has no sign-out command. Sign out from the interactive screen or delete the token file.

`update()` runs `agy update`.

## Limits

- Resume uses `--conversation <id>` with the `sessionId` from the earlier run. The whole history is replayed, so long conversations start slowly.
- Tool steps carry the input parameters but no output text.
- Usage has no cost figure. It reports input, output, cached and thinking tokens.
- Quota errors from the model API end the run with an error result. Long server retry delays are not retried.
