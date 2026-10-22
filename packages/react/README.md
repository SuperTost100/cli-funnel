<p align="center">
  <img src="https://raw.githubusercontent.com/SuperTost100/cli-funnel/main/docs/assets/icon.svg" width="80" height="80" alt="">
</p>

<h1 align="center">cli-funnel-react</h1>

<p align="center">
  React hooks and components for cli-funnel: a model picker, a transcript, a sign-in panel and an approval prompt.<br>
  Build a chat UI on top of Claude Code, Codex, Cursor Agent and Antigravity, running on the subscription you already pay for.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cli-funnel-react"><img alt="npm version" src="https://img.shields.io/npm/v/cli-funnel-react?color=f59e0b"></a>
  <a href="https://github.com/SuperTost100/cli-funnel/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/SuperTost100/cli-funnel/ci.yml?branch=main&label=checks"></a>
  <a href="https://github.com/SuperTost100/cli-funnel/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-f59e0b"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#a-chat-in-one-component">Example</a> ·
  <a href="#hooks-and-components">Hooks and components</a> ·
  <a href="https://github.com/SuperTost100/cli-funnel/blob/main/docs/ui.md">Documentation</a> ·
  <a href="https://github.com/SuperTost100/cli-funnel">cli-funnel</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/SuperTost100/cli-funnel/main/docs/screenshots/react-dark.png">
  <img alt="The cli-funnel-react components with demo data. The picker shows Claude Code, the model Claude Sonnet 5.5, high reasoning, the project folder /home/you/projects/demo and Supervised machine access. Below it the transcript shows the prompt 'What is 17 times 23?' answered with '17 times 23 is 391.', then a second prompt waiting on a Write tool call, and an approval prompt with Allow and Deny buttons." src="https://raw.githubusercontent.com/SuperTost100/cli-funnel/main/docs/screenshots/react-light.png">
</picture>

## What it needs

The components do not start any CLI themselves. They talk to a cli-funnel server over HTTP, and that server runs the CLIs on its own machine, signed in with the account you already have. Nothing goes through a cli-funnel service, because there is none. Your prompts go where they would go if you typed them into the CLI.

So you need two more things:

- **A server.** Mount `createHandler` from `cli-funnel/server` in your app, as in the example below, or run `npx cli-funnel serve`. The handler starts programs and can browse folders on its machine, so set a `token` when anyone but you can reach it.
- **The browser client.** `createClient` from `cli-funnel/client` has no React dependency. You pass it to every hook and component.

## Install

You need React 18 or newer and `cli-funnel` 0.5.1 or newer, which the package takes as peer dependencies.

```bash
npm install cli-funnel-react cli-funnel
```

## A chat in one component

First the server. This is a Next.js route at `app/api/funnel/[...path]/route.ts`. Any framework that uses the standard `Request` and `Response` works the same way.

```ts
import { createFunnel } from "cli-funnel";
import { createHandler } from "cli-funnel/server";

const handler = createHandler(createFunnel(), { basePath: "/api/funnel" });

export const GET = handler;
export const POST = handler;
```

Then the UI. The picker holds the provider, model, folder and access level. `useRun` streams the answer, and each approval it asks for becomes an `ApprovalPrompt`.

```tsx
import { useState } from "react";
import { createClient, type Selection } from "cli-funnel/client";
import { ApprovalPrompt, FunnelPicker, FunnelTranscript, useRun } from "cli-funnel-react";
import "cli-funnel-react/styles.css";

const client = createClient({ baseUrl: "/api/funnel" });

export function Chat() {
  const [selection, setSelection] = useState<Selection>();
  const [prompt, setPrompt] = useState("");
  const run = useRun(client, { keepTranscript: true });

  return (
    <>
      <FunnelPicker client={client} onChange={setSelection} />
      <FunnelTranscript turns={run.turns} />
      {run.approvals.map((request) => (
        <ApprovalPrompt key={request.id} request={request} onDecide={run.approve} />
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (selection) void run.send(prompt, selection);
        }}
      >
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button disabled={!selection || run.status === "running"}>Send</button>
      </form>
    </>
  );
}
```

`onChange` receives `undefined` until the selection is complete, so the button stays disabled until a provider, model and folder are set. The package starts with `"use client"`, so a Next.js page can import it. Create the client and render the components inside a client component.

To run the server on its own, start `npx cli-funnel serve --cors http://localhost:5173` and point `createClient` at `http://127.0.0.1:4747`. The `--cors` value is the origin of your app.

## Hooks and components

| Name                | What it does                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `FunnelPicker`      | Provider, model, reasoning, fast mode, project folder and access level. Shows only what the provider has. |
| `FunnelPickerView`  | The same markup on a `useSelection` state you own, for when other parts of your UI need the selection.    |
| `FunnelTranscript`  | Each prompt, its tool calls, the answer, token counts and any rate-limit notice.                          |
| `ApprovalPrompt`    | Allow and Deny for one approval request of a supervised run.                                              |
| `FunnelLogin`       | Sign-in, sign-out and one-click update for one provider.                                                  |
| `useProviders`      | The installed providers and their login state.                                                            |
| `useSelection`      | A `Selection` that stays valid when the provider changes. Takes `defaults`, `locked` and `pick`.          |
| `useAuth`           | The state behind `FunnelLogin`, for your own sign-in markup.                                              |
| `useRun`            | Streams one run: `text`, `turns`, `approvals`, `status`, `cancel` and `newConversation`.                  |

`locked` hides a control and fixes its value, so one component covers both "let the user choose" and "always supervised". Styles are CSS variables that start with `--cf-` and follow `prefers-color-scheme`. Override them on the `.cf` class.

## Documentation

The full guide is [UI components](https://github.com/SuperTost100/cli-funnel/blob/main/docs/ui.md). It covers the server's host and origin checks, every client method, the transcript fields, run limits and the CSS variables. The rest of cli-funnel is in the [main README](https://github.com/SuperTost100/cli-funnel#readme).

## License

[MIT](https://github.com/SuperTost100/cli-funnel/blob/main/LICENSE).
