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

An aborted turn ends with `finishReason: "cancelled"`. What happens to the process depends on the provider:

- **Codex** keeps the app-server when the abort ended cleanly: Codex acknowledged `turn/interrupt` and sent `turn/completed` for the turn within five seconds. The next turn runs on the same process and thread. If Codex did not acknowledge the interrupt, did not end the turn in time, or had not started the turn yet, the process stops.
- **Claude Code** stops the process. It has no interrupt call, so the conversation may be mid-answer and cli-funnel does not try to reuse it.

A consumer that stops reading before `done` or `error` also stops the process. Stopping right at `done` is fine and keeps it. After a stopped process, the next turn with that `sessionId` resumes in a new one.

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

## Fork a session

Forking continues a conversation in a new session and leaves the old one as it was. There are two ways, and both work with `keepAlive`.

**Claude Code** forks on a run. Pass `providerOptions.claude.forkSession` with the `sessionId` to fork from:

```ts
const branch = await funnel.run({
  selection,
  prompt: "Try the other approach.",
  sessionId: first.sessionId,
  providerOptions: { claude: { forkSession: true } },
});
// branch.sessionId is new. first.sessionId still has its own live process.
```

The fork starts its own process, and the parent's process stays up. Both sessions then continue on their own processes, and the fork's next turns need no `forkSession`. In a live test with `claude-haiku-4-5-20251001`, the fork knew what the parent had been told, and a word told to the fork never reached the parent.

**Codex** forks without a run. `funnel.forkSession("codex", sessionId)` copies the saved thread with `thread/fork` and resolves with the new session id. Pass that id as `sessionId` on the next run. The call starts a short-lived app-server and stops it when the answer arrives. Other providers throw `unsupported`.

## List saved threads

`funnel.listThreads("codex", options)` lists the conversations Codex saved, newest update first, with `thread/list`. It works with or without `keepAlive`, and other providers throw `unsupported`.

```ts
const { threads, nextCursor } = await funnel.listThreads("codex", { cwd: "/srv/app", search: "parser", limit: 20 });
// threads[0] is { provider, sessionId, title, cwd, createdAt, updatedAt, forkedFrom? }
const next = await funnel.listThreads("codex", { cursor: nextCursor });
```

`title` is the name the user gave the thread, or the start of its first message. Times are milliseconds since the epoch. A fork that has no turn of its own yet is not listed, but it can be resumed. Pass `env: { CODEX_HOME: dir }` to read another Codex home.

## Read usage and limits

`funnel.rateLimits("codex")` calls `account/rateLimits/read` and resolves with the account's plan and usage windows. `limit` is set when a window is full, and it is the same value a `limit` event carries, so one handler can read both.

```ts
const usage = await funnel.rateLimits("codex");
// { provider: "codex", plan: "plus",
//   primary: { usedPercent: 7, windowMinutes: 300, resetsAt: "..." },
//   secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: "..." } }
if (usage.limit) wait(usage.limit.resetAt);
```

During a run, Codex still reports a reached limit as a `limit` event. See [Limits](run-options.md#rate-limits-and-quotas). The call is for checking before you start a run. Other providers throw `unsupported`.

## Over HTTP

A server made with `sessions.keepAlive` exposes the live sessions. Without it, all three routes answer 409 with code `unsupported`. They sit behind the same token and host checks as every other route.

| Route | Effect |
| --- | --- |
| `GET /sessions` | The array `funnel.sessions()` returns |
| `POST /sessions/<id>/steer` | Body `{ "text": "...", "provider": "codex" }`. Adds a message to the running turn. `provider` is optional |
| `DELETE /sessions/<id>?provider=codex` | Closes the session's process. 404 when it has none |

A steer that Codex cannot take, such as a session with no running turn, answers 400. Claude Code sessions answer 409, since they have no steer.

```bash
curl http://127.0.0.1:4747/sessions
curl -X POST http://127.0.0.1:4747/sessions/<id>/steer -d '{"text":"Keep the public API unchanged."}'
curl -X DELETE http://127.0.0.1:4747/sessions/<id>
```

The browser client has `client.sessions()`, `client.steer(sessionId, text, provider?)` and `client.closeSession(sessionId, provider?)`. Listing threads, forking and reading usage are library calls only.

## Subagent text

Claude Code runs subagents for the `Agent` tool. By default their messages stay out of the stream. Set `providerOptions.claude.forwardSubagentText` to pass `--forward-subagent-text`, and each text block a subagent writes arrives as a `subagent.text` event:

```ts
for await (const e of funnel.stream({ selection, prompt, providerOptions: { claude: { forwardSubagentText: true } } })) {
  if (e.type === "tool.start" && e.name === "Agent") console.log("started", e.id);
  if (e.type === "subagent.text") console.log(`[${e.agent}] ${e.text}`, "from call", e.parentId);
}
```

`parentId` is the `id` of the `tool.start` that started the subagent. `agent` is the subagent's name when Claude Code reports it. The events carry whole messages, not deltas. They are not part of `result.text`. Like every provider option, the flag is set when the process starts, so a turn that changes it gets a new process. Claude Code sends the subagent's thinking blocks empty, so they are not forwarded.
