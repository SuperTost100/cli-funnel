# Adding a provider

A provider is one object that implements `Provider` from `src/types.ts`. Add a folder under `src/providers/<id>/` and register it in `src/providers/index.ts`.

## What to implement

| Member | Job |
|---|---|
| `capabilities` | The access levels the CLI can really enforce headlessly, whether it has effort, context window, fast mode and resume, and how it takes a system prompt, images and a response schema. |
| `detect()` | Find the binary, read its version, report the tested range. `detectInstallation` in `providers/base.ts` does most of it. |
| `authStatus()` | Read sign-in state without spending quota. |
| `login()` | Start the CLI's login and yield `open-url`, `code-prompt`, `needs-terminal`, `done` or `error`. `spawnLogin` covers CLIs that print a URL. |
| `logout()`, `update()` | Call the CLI's commands. `runLogout` and `runUpdate` do it. |
| `models()` | Merge live CLI output with `data/models/<id>.json` using `mergeModels`. |
| `run(input)` | Spawn the CLI and yield `FunnelEvent`s. |

## Rules

Access levels are a promise. List `supervised` only if a human can approve each action from your event stream. If the CLI auto-denies in headless mode, leave `supervised` out. The picker then never offers it.

For `supervised`, yield an `approval.request` event, then await `input.onApproval(request)` and send the answer to the CLI.

Model ids in the manifest are real versioned names. No `latest`.

Keep the parser a pure function from one raw line to zero or more events. Test it against fixtures recorded from the real CLI.

Abort the process when `input.signal` fires.

## Providers without a binary

Providers that call an HTTP API spawn nothing. `detect()` reports whether the server answers and puts the reason in `installation.detail` when it does not. `capabilities.access` stays empty. If the server keeps no session, wrap the call in `runWithHistory` from `providers/history.ts`. If it speaks Chat Completions, reuse `streamChatCompletions` from `providers/api.ts`. See `providers/ollama/` and `providers/openai-compatible.ts`.

## Register it

```ts
export const PROVIDERS = { ..., myprovider: myProvider };
```

Add the id to `CliProviderId` in `src/types.ts` and a `data/models/myprovider.json` file. To try a provider without editing the package, pass it in:

```ts
createFunnel({ providers: { claude: myReplacement } });
```
