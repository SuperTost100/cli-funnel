# Ollama

Provider id `ollama`. Talks to an Ollama server over its native HTTP API. Nothing is spawned and no key is needed. Tested against Ollama 0.35.1, minimum 0.35.0.

## Server address

The provider uses the first of these that is set:

1. `createFunnel({ ollama: { baseUrl } })`
2. `OLLAMA_HOST`, read the way Ollama reads it: no scheme means `http`, no port means `11434`, and `0.0.0.0` means this machine
3. `http://127.0.0.1:11434`

For a server behind a proxy that checks a token, pass `ollama: { baseUrl, apiKey }`. The key goes in an `Authorization: Bearer` header.

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
| effort | no |
| contextWindow | no |
| fast | no |
| resume | yes, history kept in process memory |
| approvals | no |
| images | yes, for models that accept them |
| system | native |
| schema | native |

`cwd` and `access` are ignored, as for the API providers.

## Models

`models()` reads `/api/tags`. Ids are the names the server reports, such as `llama3.2:3b` or `qwen3:latest`. This is the one place cli-funnel shows a tag like `latest`: the server decides what it points to, and cli-funnel never makes one up. The display name adds the first eight characters of the digest, `smollm2:135m (9077fe9d)`, so you can tell which weights a run used. Models whose capabilities do not include `completion`, such as embedding models, are dropped.

`allowUnlistedModels` is not needed. A model has to be pulled before it can run, and then it is listed.

## Runs

A run is one `POST /api/chat` with `stream: true`. The stream is newline-delimited JSON.

| Input | Request |
| --- | --- |
| `system` | a `system` message in front of the history, sent on every call and never stored |
| `attachments` | `images` on the user message |
| `responseSchema` | `format` |
| `maxOutputTokens` | `options.num_predict` |

| Stream line | Event |
| --- | --- |
| `message.thinking` | `reasoning.delta` |
| `message.content` | `text.delta` |
| `done: true` | `usage` from `prompt_eval_count` and `eval_count`, then `done` |
| `error` | `error` |

A stream that ends without `done: true` ends with an error. Aborting the signal ends the run with `finishReason: "cancelled"`. Thinking models think by default. There is no effort control yet.

## Sign-in and update

There is nothing to sign in to. `authStatus()` is signed in when `/api/tags` answers, and signed out with a reason when the server refuses (401 or 403) or does not answer. `login()` and `logout()` say so. `update()` changes nothing: update Ollama with its own installer.

## Live test

`CLI_FUNNEL_LIVE=1 CLI_FUNNEL_OLLAMA_MODEL=smollm2:135m npm test` runs the live test against `CLI_FUNNEL_OLLAMA_URL`, then `OLLAMA_HOST`, then the default address. Without `CLI_FUNNEL_OLLAMA_MODEL` the live test is skipped.
