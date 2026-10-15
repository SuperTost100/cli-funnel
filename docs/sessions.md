# Live sessions

By default every turn starts a new CLI process and resumes the conversation by `sessionId`. With `sessions.keepAlive`, Claude Code and Codex keep their process between turns, so the next turn of the same session skips the startup. In a live test with `claude-haiku-4-5-20251001` the second turn took 1.0 s instead of 2.0 s; with Codex `gpt-5.6-luna` it took 1.1 s instead of 4.1 s.

```ts
const funnel = createFunnel({ sessions: { keepAlive: true, idleMs: 5 * 60_000 } });

const first = await funnel.run({ selection, prompt: "Read the README." });
// Same session id and same settings: runs on the process the first turn started.
const second = await funnel.run({ selection, prompt: "Now summarize it.", sessionId: first.sessionId });

funnel.close(); // stop every live process
```

Other providers ignore the option and run as before.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `keepAlive` | `false` | Keep Claude Code and Codex processes between turns |
| `idleMs` | 10 minutes | Close a live session after this long without a turn |
| `max` | 8 | Most live sessions at once. Above it, the least recently used idle session closes |

## When a turn reuses a process

A turn runs on a live process when all of these hold:

- it passes the `sessionId` of a live session from the same provider;
- no other turn is running in that session;
- the process was started with the same model, effort, context window, fast mode, `cwd`, access, `system`, `responseSchema`, `env`, and with or without `onApproval`.

If the settings differ, cli-funnel stops the old process and starts a new one that resumes the session, as it would without `keepAlive`. A second turn sent while one is still running gets its own process, also as before.

A turn without `sessionId` always starts a new process, which then stays alive under the session id it reports.

## Abort and approvals

Each turn has its own `signal` and `onApproval`. Approval requests go to the handler of the turn that is running.

An aborted turn ends with `finishReason: "cancelled"` and its process stops: the conversation may be mid-answer and cli-funnel does not try to reuse it. The same happens when a consumer stops reading before `done` or `error`. Stopping right at `done` is fine and keeps the process. The next turn with that `sessionId` resumes in a new process.

## Steer a running turn

`funnel.steer(sessionId, text)` adds a user message to the turn that is running. Codex sends it with `turn/steer` and the model takes it into account before the turn ends.

```ts
const stream = funnel.stream({ selection, prompt: "Refactor the parser.", sessionId });
setTimeout(() => funnel.steer(sessionId, "Keep the public API unchanged."), 5_000);
for await (const event of stream) render(event);
```

`steer` throws `FunnelError` with code:

- `unsupported` for Claude Code, and for any funnel without `keepAlive`;
- `invalid-selection` when the session has no live process or no turn is running.

Claude Code has no steer. In stream-json mode it reads a message sent during a turn as the next turn, not as part of the current one.

## List and close sessions

| Call | Effect |
| --- | --- |
| `funnel.sessions()` | Live sessions: provider, session id, model, `cwd`, access, `busy`, whether `steer` works, `lastUsed` |
| `funnel.closeSession(sessionId, provider?)` | Stops one process. Returns `false` when there was none. A running turn ends as cancelled |
| `funnel.close()` | Stops every live process. Later turns start new ones |

Idle processes do not keep your program running. When it exits, cli-funnel kills the processes that are left. Claude Code saves the session after each turn, so a later run can still resume it.

## Not there yet

- `thread/list`, `thread/fork` and `account/rateLimits/read` on the Codex app-server.
- Claude Code `--fork-session` and `--forward-subagent-text`.
- The HTTP server and the browser client have no endpoints for `steer`, `sessions` or `closeSession`.
