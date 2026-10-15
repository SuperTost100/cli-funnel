# UI components

`cli-funnel-react` has hooks for building your own UI and four small components. It talks to the HTTP handler from `cli-funnel/server`.

## Server side

Mount the handler in any framework that uses the standard `Request` and `Response`.

```ts
// Next.js app router: app/api/funnel/[...path]/route.ts
import { createFunnel } from "cli-funnel";
import { createHandler } from "cli-funnel/server";

const handler = createHandler(createFunnel(), { basePath: "/api/funnel", token: process.env.FUNNEL_TOKEN });

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

## Client

```ts
import { createClient } from "cli-funnel/client";
const client = createClient({ baseUrl: "/api/funnel", token });
```

The client has no React dependency. It works in any browser or runtime.

It mirrors the funnel: `providers()`, `models(id)`, `authStatus(id)`, `login(id)`, `logout(id)`, `update(id)`, `run(input)`, and on Ollama `pullModel(id, name, signal)` and `deleteModel(id, name)`.

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

It shows provider, model, reasoning, context window, fast mode, project folder and access level. Only controls the chosen provider supports appear. Switching provider or model resets dependent fields to valid values. `onChange` receives a complete `Selection`, or `undefined` while something is missing.

Providers without access levels (Ollama, API providers, OpenAI-compatible servers) have no folder and no machine access. The picker hides those two controls and a selection is complete once provider and model are set. Its `access` is `"none"` and its `cwd` is empty.

`locked` fields are hidden and always applied. That is how you hardcode part of a selection. If the provider cannot honor a locked field, for example `access: "supervised"` on a provider that lacks it, the picker shows why and `onChange` stays `undefined`. `useSelection` returns the same text as `problem`.

If the model list fails to load, the picker shows the error with a Retry button. `useSelection` returns it as `modelsError`, and `refresh()` loads the models again.

## Next.js

The package starts with a `"use client"` directive, so a Server Component can import it without a hooks error. Props must still be serializable, and `client` holds functions. Create the client and render the components inside a file that starts with `"use client"`, as `examples/next-app` does.

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

`useRun` keeps the session id between calls, so the next `send` continues the conversation. `newConversation()` ends the run in flight and clears the session. Calling `send` during a run cancels that run first. Leaving the page cancels it too.

`run.result` has `text`, `provider`, `model`, `sessionId`, `usage`, `finishReason`, `toolCalls`, `deniedActions` and `structured`. `provider` and `model` are the ones you passed to `send`, even if the picker has changed since. If `approve` fails, the prompt stays and `run.error` has the message, so the user can press the button again.

`run.result` summarizes the latest run in the shape of `funnel.run()`: `text`, `provider`, `model`, `sessionId`, `usage`, `finishReason`, `toolCalls`, `deniedActions` and `structured`. When you pass `responseSchema` to `send` and the provider does not report a parsed answer, `structured` is the answer text parsed as JSON, or `structuredError` says why that failed. Validate it against your schema yourself.

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
| `status` | `running`, `done` or `error`. `error` holds the message. |

`FunnelTranscript` shows each prompt, its tool calls as closed `<details>` rows (open one for the input, output and error), the answer, and a line with provider, model and token counts. It renders nothing while `turns` is empty, so show your own empty state. It uses the same `--cf-` variables as the picker.

## Hooks only

`useProviders`, `useSelection`, `useAuth` and `useRun` hold all the logic. Build your own markup on top and skip the components.
