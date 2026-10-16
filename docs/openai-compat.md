# OpenAI compatibility

`cli-funnel serve` exposes `/v1/models` and `/v1/chat/completions`. Any OpenAI SDK, or any tool that lets you set a base URL, can use your CLI subscriptions.

```bash
npx cli-funnel serve --cwd /path/to/project --access accept-edits
```

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:4747/v1", apiKey: "unused" });

const res = await client.chat.completions.create({
  model: "claude/claude-sonnet-5",
  messages: [{ role: "user", content: "Explain src/index.ts" }],
});
```

`apiKey` can be any string unless you started the server with `--token`. Then it must equal the token.

## Model ids

Ids are `<provider>/<model>`, for example `claude/claude-sonnet-5`, `codex/gpt-5.3-codex`, `ollama/llama3.2:3b` or `openai-compatible:lmstudio/qwen/qwen3-8b`. The provider id ends at the first slash. `GET /v1/models` lists the models of providers that are installed and signed in. `GET /v1/models/{id}` returns one of them, or a 404 in the OpenAI error format.

## Mapping

| OpenAI field | cli-funnel |
|---|---|
| `messages` | Flattened into one prompt. With a session id, only the last user message is sent. |
| `system` messages | `system`, joined in order |
| `image_url` parts with a `data:` URL, last user message | `attachments`. Remote URLs are ignored, so the server never fetches for a client |
| `response_format` of type `json_schema` | `responseSchema`. `message.content` is the JSON of the structured answer. With `stream: true` it arrives as one content chunk at the end. |
| `max_completion_tokens`, `max_tokens` | `maxOutputTokens` |
| `stream: true` | Server-sent events, ending with `[DONE]`. Errors that happen before the first event are a normal error response with a 4xx status. Later errors arrive as a `data:` line with an `error` object. |
| `stream_options.include_usage` | A last chunk with `choices: []` and `usage`, as OpenAI sends it. Without the option, streams carry no usage. |
| `reasoning_effort` | `selection.effort` |
| `usage.prompt_tokens`, `completion_tokens`, `total_tokens` | From the CLI's usage report, when it gives one. |
| `finish_reason` | `length` for `finishReason: "length"`, `content_filter` for `denied`, `stop` otherwise |

## Extensions

Chat completions cannot carry a folder or an access level, so the server takes them from its flags. When a provider cannot enforce the server's access level, it gets the next stricter one it can. Cursor Agent has no `accept-edits`, so it runs with `none` under the default. Override per request with `x_funnel`:

```json
{ "x_funnel": { "cwd": "/path", "access": "full", "sessionId": "abc", "fast": true, "contextWindow": 1000000 } }
```

The response carries `x_funnel.sessionId`, `toolCalls` and `deniedActions`. A streamed response carries them on the chunk with `finish_reason`. Send the session id back to continue the conversation.

The folder is checked against the server's `fsRoots` on every request, the default one included. Providers with no access levels (Ollama, API providers, OpenAI-compatible servers) ignore it.

`x_funnel.runId` names the run. A streaming response has it in the first chunk. `POST /runs/<runId>/cancel` stops the run, as described in [Run options](run-options.md#cancel-a-run).

When the server limits concurrent runs, a request waits for a free slot before the answer starts. If it had to wait, the response carries `x_funnel.queued: { waitedMs }`. A full queue gets 429 with `retry-after`. See [Concurrency limits and the queue](run-options.md#concurrency-limits-and-the-queue).

`x_funnel.providerOptions` takes the same object as `providerOptions` on a run. See [Run options](run-options.md#provider-options) for what each CLI accepts at each access level:

```json
{ "x_funnel": { "access": "accept-edits", "providerOptions": { "claude": { "addDirs": ["/path/shared"], "maxBudgetUsd": 1 } } } }
```

Every `addDirs` path must sit inside the server's allowed roots, like `x_funnel.cwd`, or the request gets 403. An option the access level does not allow fails with code `invalid-selection`: a 400 without `stream`, an error event in the stream with it.

## Limits

The OpenAI wire format has no approve button. Requests to this endpoint therefore deny anything that needs approval, and `supervised` behaves as deny-by-default. Use `accept-edits`, `auto` or `full` here, or use the `/run` route and `useRun` when a human should approve actions.

Tool calls happen inside the CLI. They do not appear as OpenAI `tool_calls`.

Fields the server cannot honour get a 400 with `error.param` set, instead of being ignored: `tools` (when not empty), `tool_choice` (other than `none` or `auto`), `n` other than 1, `stop`, `temperature` or `top_p` other than 1, `seed`, and `response_format` of type `json_object`. A body that is not valid JSON, or has no `model` string or no non-empty `messages` array of objects with a `role`, gets a 400 too. Bodies over 10 MB get a 413. `maxBodyBytes` on the handler changes the limit.
