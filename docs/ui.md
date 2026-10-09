# UI components

`cli-funnel-react` has hooks for building your own UI and three small components. It talks to the HTTP handler from `cli-funnel/server`.

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

`locked` fields are hidden and always applied. That is how you hardcode part of a selection.

Styles use CSS variables prefixed `--cf-` and follow `prefers-color-scheme`. Override them on any parent element.

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

`useRun` keeps the session id between calls, so the next `send` continues the conversation. `newConversation()` clears it.

## Hooks only

`useProviders`, `useSelection`, `useAuth` and `useRun` hold all the logic. Build your own markup on top and skip the components.
