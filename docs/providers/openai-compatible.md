# OpenAI-compatible servers

Any server that speaks the OpenAI Chat Completions API can be a provider: LM Studio, the llama.cpp server, vLLM, Ollama's `/v1`, or a hosted gateway. Configure each server once, and it shows up as its own provider.

```ts
const funnel = createFunnel({
  openaiCompatible: [
    { id: "lmstudio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
    { id: "gateway", name: "Team gateway", baseUrl: "https://llm.example.com/v1", apiKey: keychainValue, models: ["qwen3-32b"] },
  ],
});

await funnel.run({
  selection: { provider: "openai-compatible:lmstudio", model: "qwen/qwen3-8b", cwd: process.cwd(), access: "full" },
  prompt: "Summarize this changelog",
});
```

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits and dashes. The provider id is `openai-compatible:<id>`. A bad or repeated id throws `invalid-selection`. |
| `name` | Shown in pickers. |
| `baseUrl` | What you would give an OpenAI SDK, usually ending in `/v1`. cli-funnel adds `/models` and `/chat/completions`. |
| `apiKey` | Optional. Sent as `Authorization: Bearer`. |
| `models` | Optional. Used only when the server's `/models` fails or lists nothing. |

These providers exist only when configured. Nothing is probed by default.

## Capabilities

Same as the API providers: no machine access, history kept in process memory, native `system`, images and JSON schema. `cwd` and `access` are ignored.

| Input | Request |
| --- | --- |
| `system` | a system message, sent on every call and never stored |
| `attachments` | `image_url` parts with a `data:` URL |
| `responseSchema` | `response_format` of type `json_schema` |
| `maxOutputTokens` | `max_tokens`, which more servers accept than `max_completion_tokens` |

Whether the server honours images or the schema depends on the server and the model. cli-funnel sends them and reports what comes back.

Reasoning text arrives as `reasoning.delta`. Servers name the field `reasoning_content` (vLLM, llama.cpp, LM Studio) or `reasoning` (Ollama), and both are read. Usage comes from the last chunk when the server honours `stream_options.include_usage`, including `cachedInputTokens` when it reports `prompt_tokens_details.cached_tokens`.

## Models

Ids are passed through as `/models` returns them, the same exception to the no-alias rule as [Ollama](ollama.md). When the server has no `/models` route, list the ids yourself in `models`.

## Status

- `detect()` calls `/models`. Any HTTP answer, even a 404, means the server is up. No answer means `installed: false`, and `installation.detail` says where it looked.
- `authStatus()` is signed out on 401 or 403, and signed in otherwise.
- `login()`, `logout()` and `update()` change nothing. The key lives in your configuration.

## Through the cli-funnel server

On `cli-funnel serve` and `createHandler`, model ids are `openai-compatible:<id>/<model>`, for example `openai-compatible:lmstudio/qwen/qwen3-8b`. The provider id ends at the first slash.

## Live test

`CLI_FUNNEL_LIVE=1 CLI_FUNNEL_OPENAI_COMPAT_URL=http://127.0.0.1:1234/v1 CLI_FUNNEL_OPENAI_COMPAT_MODEL=<id> npm test` runs it. `CLI_FUNNEL_OPENAI_COMPAT_KEY` sets a key. It was run against Ollama 0.35.1's `/v1`.
