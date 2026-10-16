# Ollama

Provider id `ollama`. Talks to an Ollama server over its native HTTP API. Nothing is spawned and no key is needed. Tested against Ollama 0.35.1, minimum 0.35.0.

## Server address

The provider uses the first of these that is set:

1. `createFunnel({ ollama: { baseUrl } })`
2. `OLLAMA_HOST`, read the way Ollama reads it: no scheme means `http`, no port means `11434`, and `0.0.0.0` means this machine
3. `http://127.0.0.1:11434`

For a server behind a proxy that checks a token, pass `ollama: { baseUrl, apiKey }`. The key goes in an `Authorization: Bearer` header.

To keep a model loaded between turns on a shared server, pass `ollama: { keepAlive: "30m" }`. See [Keep alive](#keep-alive).

```ts
const funnel = createFunnel({ ollama: { baseUrl: "http://gpu-box:11434" } });

await funnel.run({
  selection: { provider: "ollama", model: "llama3.2:3b", cwd: process.cwd(), access: "full" },
  prompt: "Summarize this changelog",
});
```

The provider is always registered. `detect()` calls `/api/version`. When nothing answers it reports `installed: false`, and `installation.detail` says where it looked. A run on a server that is down fails with `not-installed` and the same message.

## Capabilities

| Field | Value |
| --- | --- |
| access | none listed, the provider has no machine access |
| effort | yes, for models that report the `thinking` capability |
| contextWindow | yes, with sizes up to the model's limit |
| sampling | yes |
| fast | no |
| resume | yes, history kept like the API providers' |
| approvals | no |
| images | yes, for models that accept them |
| messages | yes |
| tools | yes, for models that report the `tools` capability. No tool choice: `none` drops the tools, `required` and a named tool are refused. |
| system | native |
| schema | native |

`cwd` and `access` are ignored, as for the API providers.

## Models

`models()` reads `/api/tags`. Ids are the names the server reports, such as `llama3.2:3b` or `qwen3:latest`. This is the one place cli-funnel shows a tag like `latest`: the server decides what it points to, and cli-funnel never makes one up. The display name adds the first eight characters of the digest, `smollm2:135m (9077fe9d)`, so you can tell which weights a run used. Models whose capabilities do not include `completion`, such as embedding models, are dropped.

`/api/tags` also reports each model's capabilities and context length, and the provider reads both, so listing models costs one request.

- **Effort.** A model with the `thinking` capability has one effort, `on`. The gpt-oss models have `low`, `medium` and `high`. Other models have none.
- **Context window.** A model with a reported context length offers doubling sizes from 4096 up to that length, and the length itself. `defaultContextWindow` is not set, because the server picks its own default.

A server that reports neither field, which may be an older one, gets models with no effort and no context sizes.

`allowUnlistedModels` is not needed. A model has to be pulled before it can run, and then it is listed.

## Runs

A run is one `POST /api/chat` with `stream: true`. The stream is newline-delimited JSON.

| Input | Request |
| --- | --- |
| `system` | a `system` message in front of the history, sent on every call and never stored |
| `attachments` | `images` on the user message |
| `responseSchema` | `format` |
| `maxOutputTokens` | `options.num_predict` |
| `sampling.temperature`, `topP`, `stop`, `seed` | `options.temperature`, `top_p`, `stop`, `seed` |
| `selection.effort` | `think`: `true` for `on`, otherwise the level |
| `selection.contextWindow` | `options.num_ctx` |
| `ollama.keepAlive` | `keep_alive` |
| `ollama.options` | merged into `options`, and wins over the rows above |

| Stream line | Event |
| --- | --- |
| `message.thinking` | `reasoning.delta` |
| `message.content` | `text.delta` |
| `done: true` | `usage` from `prompt_eval_count` and `eval_count`, then `done` |
| `error` | `error` |

A stream that ends without `done: true` ends with an `error` event with code `stream-truncated`. If a line was not JSON, the error shows its first 200 characters instead. The run returns as soon as `done: true` arrives, even if the connection stays open. Aborting the signal ends the run with `finishReason: "cancelled"`. Thinking models think by default, and `message.thinking` arrives as `reasoning.delta` with or without an effort. Setting an effort sends `think` explicitly, which is how a gpt-oss model gets its level.

## Context window

`selection.contextWindow` becomes `options.num_ctx`, the number of tokens the model keeps in view. Without it the server uses its own default, and a long prompt is cut to fit. A larger window costs memory on the server for the key-value cache, so pick one the machine can hold.

## Keep alive

By default the server unloads a model five minutes after the last request, and the next run pays the load time again. `keepAlive` changes that. It takes a duration such as `"30m"`, a number of seconds, `-1` to keep the model loaded, or `0` to unload it right after the run.

```ts
const funnel = createFunnel({ ollama: { keepAlive: "30m" } });

await funnel.run({ selection, prompt, ollama: { keepAlive: 0 } });
```

The funnel-level value applies to every run. `ollama.keepAlive` on a run overrides it, and `0` counts as a value.

## Other options

`ollama.options` on a run passes any other model option, such as `top_k` or `repeat_penalty`, straight to the server. cli-funnel does not check the names or values. An entry here beats the same key set through `sampling`, `maxOutputTokens` or `selection.contextWindow`.

```ts
await funnel.run({ selection, prompt, ollama: { options: { top_k: 40, repeat_penalty: 1.1 } } });
```

## Pull and delete models

Ollama is the one provider with `capabilities.manageModels`. It downloads and removes models through the server.

```ts
for await (const e of funnel.pullModel("ollama", "llama3.2:3b", { signal })) {
  if (e.type === "progress") console.log(e.status, e.completed, e.total);
  if (e.type === "error") console.error(e.message);
}
await funnel.deleteModel("ollama", "llama3.2:3b");
```

- `pullModel` streams `/api/pull`. Each `progress` event carries the server's status line, and while a layer downloads, its `digest`, `completed` and `total` bytes. The stream ends with `done`, or with `error` when the server reports one, for example an unknown model name. Aborting the signal stops the download and ends the stream with no further event.
- `deleteModel` calls `DELETE /api/delete`. A model that is not on the server throws `invalid-selection`.
- On every other provider both throw `unsupported`.

The HTTP handler exposes them as `POST /providers/ollama/models/pull` (SSE) and `POST /providers/ollama/models/delete`, both with `{ "name": "<model>" }`. The browser client has `client.pullModel(id, name, signal)` and `client.deleteModel(id, name)`. From a terminal:

```bash
npx cli-funnel pull ollama llama3.2:3b
npx cli-funnel rm ollama llama3.2:3b
```

Pulling uses disk space and bandwidth on the machine that runs the server, and deleting cannot be undone. Ask the user before doing either.

## Sign-in and update

There is nothing to sign in to. `authStatus()` is signed in when `/api/tags` answers, and signed out with a reason when the server refuses (401 or 403) or does not answer. `login()` and `logout()` say so. `update()` changes nothing: update Ollama with its own installer.

## Live test

`CLI_FUNNEL_LIVE=1 CLI_FUNNEL_OLLAMA_MODEL=smollm2:135m npm test` runs the live test against `CLI_FUNNEL_OLLAMA_URL`, then `OLLAMA_HOST`, then the default address. Without `CLI_FUNNEL_OLLAMA_MODEL` the live test is skipped. `CLI_FUNNEL_OLLAMA_PULL=all-minilm:22m` adds a test that pulls and then deletes that model. Run it only against a throwaway server.
