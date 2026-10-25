# UI components

`cli-funnel-react` has hooks for building your own UI and five small components: `FunnelPicker`, `FunnelPickerView`, `FunnelTranscript`, `FunnelLogin` and `ApprovalPrompt`. It talks to the HTTP handler from `cli-funnel/server`.

## Server side

Mount the handler in any framework that uses the standard `Request` and `Response`.

```ts
// Next.js app router: app/api/funnel/[...path]/route.ts
import { createFunnel } from "cli-funnel";
import { createHandler } from "cli-funnel/server";

const handler = createHandler(createFunnel(), { basePath: "/api/funnel" });

export const GET = handler;
export const POST = handler;
```

Or run `npx cli-funnel serve`, which uses `node:http` on `127.0.0.1:4747`.

The handler starts programs on the machine it runs on and can browse folders. Set `token` whenever anyone but you can reach it. `serve` refuses a public `--host` without `--token`.

Without a token, the handler refuses requests a website in the same browser could send, directly or through DNS rebinding. It answers when the `Host` is one of these:

- loopback: `localhost`, `127.x.x.x` or `::1`
- an IP address, such as a LAN or tailnet address
- a `*.ts.net` name, when `tailscale serve` forwarded the request for a tailnet user. Tailscale Funnel requests from the internet are always refused, whatever their `Host`. Set `tailscale: false` to refuse tailnet requests too.
- a name in `allowedHosts`. `".example.com"` also matches its subdomains, and `"*"` turns the check off.

The `Origin`, when the browser sends one, must be loopback, in `allowedHosts`, or the same host the request went to. Anything else gets a 403. Everyone who can reach an accepted name can run agents, so set a token when others share your network or tailnet. The check reads headers a reverse proxy can rewrite. Behind any proxy other than `tailscale serve` that others can reach, set a token. `cli-funnel serve` and the playground server read `allowedHosts` from `CLI_FUNNEL_ALLOWED_HOSTS`, comma-separated.

The folder picker only lists directories inside `fsRoots`, which defaults to the home directory.

`/run` and `/v1/chat/completions` refuse a project folder outside `fsRoots` with a 403, whatever the source of the folder. Providers with no access levels (Ollama, the API providers, OpenAI-compatible servers) skip the check, because they have no machine access. `createHandler` throws at startup when `openai.cwd` is set and is not inside `fsRoots`.

Every route that reads a body stops at `maxBodyBytes` (default 10 MB) and answers 413. A body that is not valid JSON, or not a JSON object, gets a 400.

A run that ends or is cancelled while it waits for an approval gets `deny` for it at once, and a question it waits on gets no answer. Approvals and questions that nobody answers time out after `approvalTimeoutSec` (default 300).

## Client

```ts
import { createClient } from "cli-funnel/client";
const client = createClient({ baseUrl: "/api/funnel", token });
```

The client has no React dependency. It works in any browser or runtime.

It mirrors the funnel. `signal` is an optional `AbortSignal`, and every method returns a promise unless it says it streams.

| Method | What it does |
| --- | --- |
| `providers(signal?)` | Installed providers with their capabilities and login state. |
| `models(id, signal?)` | The model list of one provider. |
| `authStatus(id, signal?)` | Whether the provider is signed in. |
| `login(id, signal?, { device? })` | Streams login events. The first is `{ type: "login", loginId }`. `device` asks for a device-code login. |
| `sendLoginCode(loginId, code)` | Answers a `code-prompt` login event. |
| `cancelLogin(loginId)` | Stops a login in progress. |
| `logout(id)` | Signs the provider out. |
| `update(id)` | Updates the CLI and returns what changed. |
| `run(input, signal?)` | Streams run events. The first is `{ type: "run", runId }`. |
| `approve(runId, approvalId, decision)` | Answers an approval request of a run. `decision` can be an object with a `message` for the agent. |
| `answer(runId, questionId, answers)` | Answers a `question.request`, with answers keyed by question id. `null` declines. |
| `cancelRun(runId)` | Stops a run on the server. Its stream ends with `finishReason: "cancelled"`. |
| `listDirs(path?, signal?)` | Lists the folders under `path`, inside the server's `fsRoots`. |
| `pullModel(id, name, signal?)` | Streams a model download. Ollama only. |
| `deleteModel(id, name)` | Deletes a model. Ollama only. |
| `sessions(signal?)` | Lists live sessions. Needs `sessions.keepAlive` on the server, else 409. |
| `steer(sessionId, text, provider?)` | Adds a message to the turn running in a live session. Codex only. |
| `closeSession(sessionId, provider?)` | Stops the live process of a session. The next turn resumes it in a new one. |

Pass `provider` to `steer` and `closeSession` when two providers could share a session id. See [Live sessions](sessions.md#over-http).

## Picker

```tsx
import { FunnelPicker } from "cli-funnel-react";
import "cli-funnel-react/styles.css";

<FunnelPicker
  client={client}
  defaults={{ access: "supervised" }}
  locked={{ provider: "claude" }}
  onChange={setSelection}
/>
```

`FunnelPicker` keeps its own state. When other parts of your UI need the same state, call `useSelection(client, { defaults, locked })` yourself and render `<FunnelPickerView client={client} state={state} locked={locked} />`. The two share the markup and the rules above.

It shows provider, model, reasoning, context window, fast mode, project folder and access level. Only controls the chosen provider supports appear. Switching provider or model resets dependent fields to valid values. `onChange` receives a complete `Selection`, or `undefined` while something is missing.

Providers without access levels (Ollama, API providers, OpenAI-compatible servers) have no folder and no machine access. The picker hides those two controls and a selection is complete once provider and model are set. Its `access` is `"none"` and its `cwd` is empty.

`locked` fields are hidden and always applied. That is how you hardcode part of a selection. If the provider cannot honor a locked field, for example `access: "supervised"` on a provider that lacks it, the picker shows why and `onChange` stays `undefined`. `useSelection` returns the same text as `problem`.

If the model list fails to load, the picker shows the error with a Retry button. `useSelection` returns it as `modelsError`, and `refresh()` loads the models again.

## Next.js

The package starts with a `"use client"` directive, so a Server Component can import it without a hooks error. Props must still be serializable, and `client` holds functions. Create the client and render the components inside a file that starts with `"use client"`, as `examples/next-app` does.

Do not put the handler's `token` in browser code. Anything in a `NEXT_PUBLIC_` variable ships to every visitor, and a browser client without the token gets a 401 from a handler that has one. `examples/next-app` sets no `token`, so the handler answers only the hosts listed under [Server side](#server-side). If others can reach the app, check your own session in the route before it calls the handler. Use `token` when a separate process calls the handler, for example `npx cli-funnel serve --token` with `createClient({ token })` in server code.

Styles use CSS variables prefixed `--cf-` and follow `prefers-color-scheme`. Every component's root element has the class `cf`, and `.cf` declares the variables itself, so a value set on a parent element is ignored. Override them on `.cf`:

```css
.cf {
  --cf-accent: #0a7d4f;
  --cf-radius: 4px;
}
```

Add a `@media (prefers-color-scheme: dark)` block with the same selector for dark colors.

## Login and update panel

```tsx
import { FunnelLogin, useProviders } from "cli-funnel-react";

const { providers, refresh } = useProviders(client);
providers.map((p) => <FunnelLogin key={p.id} client={client} provider={p} onChange={refresh} />);
```

## Run with approvals

```tsx
import { useRun, ApprovalPrompt } from "cli-funnel-react";

const run = useRun(client);

<button onClick={() => run.send(prompt, selection)}>Run</button>
<pre>{run.text}</pre>
{run.approvals.map((r) => <ApprovalPrompt key={r.id} request={r} onDecide={run.approve} />)}
```

`useRun` keeps the session id between calls, so the next `send` continues the conversation. `newConversation()` ends the run in flight and clears the session. `cancel()` stops the run on the server and closes the stream. When the server limits concurrent runs, `queued` holds the number of runs ahead while this one waits, so you can show "2 ahead of you". Calling `send` during a run cancels that run first. Leaving the page cancels it too.

`run.result` has `text`, `provider`, `model`, `sessionId`, `usage`, `finishReason`, `toolCalls`, `deniedActions`, `structured`, `structuredError` and `limit`. It is the latest run in the shape of `funnel.run()`, without `pendingToolCalls`, because `useRun` cannot pass `tools`. `provider` and `model` are the ones you passed to `send`, even if the picker has changed since. `run.text` is `run.result.text`. If `approve` fails, the prompt stays and `run.error` has the message, so the user can press the button again. `run.questions` holds the questions the agent waits on; answer each with `run.answer(id, answers)`. Each turn in `run.turns` also keeps the latest `plan` and the `fileChanges` of that turn.

When you pass `responseSchema` to `send` and the provider does not report a parsed answer, `structured` is the answer text parsed as JSON, or `structuredError` says why that failed. Validate it against your schema yourself.

## Transcript

```tsx
import { useRun, FunnelTranscript } from "cli-funnel-react";

const run = useRun(client, { keepTranscript: true });

<FunnelTranscript turns={run.turns} />
```

With `keepTranscript`, `run.turns` holds one entry per `send` since the last `newConversation()`. Without it, `turns` holds only the latest run. Each turn has:

| Field | Meaning |
| --- | --- |
| `id` | Unique number. Use it as the React key. |
| `prompt` | The text you sent. |
| `selection` | The `Selection` this turn ran with. Changing the picker later does not touch it. |
| `model` | The model the CLI reported. Starts as `selection.model`. |
| `text` | The answer so far. It grows while the run streams. |
| `structured` | The parsed answer, when there is one. |
| `toolCalls` | Each call with `name`, `input`, `output`, `error` and `running`. |
| `deniedActions` | Names of the tool calls the CLI refused because nobody could approve them. |
| `usage`, `finishReason` | As in `run.result`. |
| `queued` | Runs ahead of this one while the server holds it for a slot. Undefined once it starts. |
| `limit`, `limitAt` | The first rate limit or quota the provider reported, as in `run.result.limit`, and when it arrived in ms since the epoch. |
| `status` | `running`, `done` or `error`. `error` holds the message. |

`FunnelTranscript` shows each prompt, its tool calls as closed `<details>` rows (open one for the input, output and error), the answer, and a line with provider, model and token counts. While the server holds a run for a slot it says how many runs are ahead. When the provider reports a limit, it adds a notice with the kind, the provider's own words and, if known, when the limit resets or when to retry, in local time. Both lines are `aria-live="polite"`. It renders nothing while `turns` is empty, so show your own empty state. It uses the same `--cf-` variables as the picker.

To see the queue in the playground, start it with `CLI_FUNNEL_MAX_CONCURRENT=1 npm run playground`, open two browser tabs and send a prompt in each. The second tab shows "You are next" until the first run finishes, and a third shows "1 run ahead". One tab cannot queue itself, because a new `send` cancels the run in flight. Without the variable the playground sets no limit. The limit notice appears only when a provider reports a rate limit or quota.

## Hooks only

`useProviders`, `useSelection`, `useAuth` and `useRun` hold all the logic. Build your own markup on top and skip the components.
