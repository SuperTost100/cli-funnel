# OpenAI compatibility

`cli-funnel serve` exposes `/v1/models`, `/v1/chat/completions` and `/v1/responses`. Any OpenAI SDK, or any tool that lets you set a base URL, can use your CLI subscriptions.

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
| `messages` | `messages` on the run. API providers and model servers get one message per turn. CLIs get a transcript, or with a session id only the messages after the last assistant message. See [Messages instead of a prompt](run-options.md#messages-instead-of-a-prompt). |
| `system` and `developer` messages | `system`, joined in order |
| `image_url` parts with a `data:` URL, in user messages | Image parts. Remote URLs get a 400, so the server never fetches for a client. |
| `response_format` of type `json_schema` | `responseSchema`. `message.content` is the JSON of the structured answer. With `stream: true` it arrives as one content chunk at the end. |
| `max_completion_tokens`, `max_tokens` | `maxOutputTokens` |
| `temperature`, `top_p`, `stop`, `seed` | `sampling`, on providers with `capabilities.sampling` (API providers, OpenAI-compatible servers, Ollama). `stop` takes a string or up to 4 strings. See [Sampling](#sampling). |
| `stream: true` | Server-sent events, ending with `[DONE]`. Errors that happen before the first event are a normal error response with a 4xx status. Later errors arrive as a `data:` line with an `error` object. |
| `stream_options.include_usage` | A last chunk with `choices: []` and `usage`, as OpenAI sends it. Without the option, streams carry no usage. |
| `reasoning_effort` | `selection.effort` |
| `tools` of type `function`, `tool_choice` | `tools` and `toolChoice`, on providers with `capabilities.tools`. See [Tool calling](run-options.md#tool-calling). |
| `tool_calls` on assistant messages, `role: "tool"` messages | `tool_call` parts, and `tool_result` parts in one user message per run of tool messages |
| `message.tool_calls` in the response | The run's `pendingToolCalls`, with `finish_reason: "tool_calls"`. Streams send each call's id and name first, then argument pieces, as OpenAI does. |
| `usage.prompt_tokens`, `completion_tokens`, `total_tokens` | From the CLI's usage report, when it gives one. |
| `finish_reason` | `length` for `finishReason: "length"`, `content_filter` for `denied`, `stop` otherwise |

## Sampling

`temperature` must be a number from 0 to 2, `top_p` a number from 0 to 1, `stop` a string or an array of at most 4 strings, and `seed` an integer. Anything else, such as `"temperature": "hot"` or `"top_p": 1.5`, gets a 400 with `code: "invalid_value"` on every provider. A `null` counts as not set.

The CLI providers cannot apply sampling. They ignore the defaults (`temperature` or `top_p` of 1, an empty `stop`, no `seed`) and answer any other value with a 400 and `code: "unsupported_value"`, so a client never gets an answer that quietly ignored its setting. `/v1/responses` follows the same rule for `temperature` and `top_p`. It has no `stop` or `seed`.

Vendors may still refuse values their models do not allow, for example a `temperature` other than 1 on recent reasoning models. That error comes back as the provider's own. The Anthropic API has no seed and ignores it.

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

## Responses endpoint

`POST /v1/responses` takes a Responses API request for any provider and turns it into a run, the same way chat completions do. `x_funnel`, `x_funnel.providerOptions` with its `addDirs` check, cancelling by run id and the queue work the same. A streamed response has `x_funnel.runId` on the `response.created` event.

```ts
const first = await client.responses.create({ model: "claude/claude-sonnet-5", input: "Explain src/index.ts" });
const next = await client.responses.create({ model: "claude/claude-sonnet-5", previous_response_id: first.id, input: "Now the tests." });
```

The response `id` is the run's session id, so `previous_response_id` continues the conversation on any provider: in the CLI, in the funnel's history, or on OpenAI for `openai-api` in Responses mode. Send only the new input items with it.

| Responses field | cli-funnel |
|---|---|
| `input` as a string | One user message |
| `input` items | `message` items with `input_text`, `output_text` and `input_image` (data URLs only) parts, `function_call` and `function_call_output` items. `reasoning` items are skipped. |
| `instructions`, `system` and `developer` messages | `system`, joined in order |
| `previous_response_id` | `sessionId`. `x_funnel.sessionId` works too. |
| `reasoning.effort` | `selection.effort` |
| `max_output_tokens` | `maxOutputTokens` |
| `temperature`, `top_p` | `sampling`, on providers with `capabilities.sampling`. Other providers get a 400 for a value other than 1. Ranges are checked as in [Sampling](#sampling). |
| `text.format` of type `json_schema` | `responseSchema`. The output text is the JSON of the structured answer. |
| `tools` of type `function`, `tool_choice` | `tools` and `toolChoice`, on providers with `capabilities.tools` |
| `output` | A `message` item with the answer and a `function_call` item per pending tool call |
| `status` | `incomplete` with `incomplete_details.reason` `max_output_tokens` or `content_filter`, else `completed` |
| `stream: true` | Server-sent events with `event:` names: `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, `response.output_text.delta`, `response.function_call_arguments.delta` and `.done`, the matching `.done` events, and `response.completed` or `response.incomplete`. An error after the stream started arrives as `response.failed`. |

`background`, `conversation`, stored `prompt` templates, `text.format` of type `json_object`, hosted tools such as web search, and `item_reference` items get a 400. `store`, `include`, `metadata` and `parallel_tool_calls` are ignored. Reasoning summaries are not streamed back on this endpoint.

On a CLI the session id is known only once the CLI reports it. When that comes after the first event, `response.created` carries a placeholder id and `response.completed` the real one.

## Limits

The OpenAI wire format has no approve button. Requests to this endpoint therefore deny anything that needs approval, and `supervised` behaves as deny-by-default. Use `accept-edits`, `auto` or `full` here, or use the `/run` route and `useRun` when a human should approve actions.

A CLI runs its own tools. They do not appear as OpenAI `tool_calls`; `x_funnel.toolCalls` lists them. The client's `tools` work only on the API providers, Ollama and OpenAI-compatible servers. The endpoint is stateless unless you send `x_funnel.sessionId`, and some vendors want more than the call back: see the end of [Tool calling](run-options.md#tool-calling).

Fields the server cannot honour get a 400 with `error.param` set, instead of being ignored: `tools` (when not empty) and `tool_choice` (other than `none` or `auto`) on a CLI provider, `n` other than 1, `temperature`, `top_p`, `stop` and `seed` on a provider without sampling, and `response_format` of type `json_object`. A body that is not valid JSON, or has no `model` string or no non-empty `messages` array of objects with a `role`, gets a 400 too, and so does a chat with a role other than `system`, `developer`, `user`, `assistant` or `tool`, a content part other than text or an image, a tool message without `tool_call_id`, a tool that is not a function, or a last message that is not from the user or a tool. Bodies over 10 MB get a 413. `maxBodyBytes` on the handler changes the limit.
