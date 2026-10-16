# API keys

Three providers call the vendor APIs directly and return the same events and result shape as the CLI providers. Switch between a subscription and a key by changing `selection.provider`.

| Provider id | Key |
|---|---|
| `anthropic-api` | `ANTHROPIC_API_KEY` |
| `openai-api` | `OPENAI_API_KEY` |
| `gemini-api` | `GEMINI_API_KEY` |

```ts
const funnel = createFunnel({ apiKeys: { anthropic: process.env.MY_KEY, gemini: keychainValue } });

await funnel.run({
  selection: { provider: "anthropic-api", model: "claude-sonnet-5", cwd: process.cwd(), access: "full" },
  prompt: "Summarize this changelog",
});
```

Without `apiKeys`, the providers read the environment variables.

## Gateways, headers and retries

`api` sets one vendor's key, base URL, extra headers and retry behavior. It works next to `apiKeys`, and a `key` in `api` wins.

```ts
const funnel = createFunnel({
  api: {
    anthropic: {
      baseUrl: "https://llm.example.com/anthropic",
      headers: { "x-team": "docs" },
    },
    openai: { key: process.env.MY_KEY, retries: 3 },
  },
});
```

| Field | Meaning |
|---|---|
| `key` | The API key. Falls back to `apiKeys`, then the environment variable. |
| `baseUrl` | Where requests go. Written the way the vendor SDK takes it, and cli-funnel adds the path after it. |
| `headers` | Sent with every request, including model lists, after the default headers. A name that matches a default in any letter case replaces it. |
| `retries` | Extra attempts after a 429 or 5xx. Default 2. `0` turns retries off. |
| `retryDelayMs` | First wait before a retry. Default 500, doubled each time. |

The default base URLs are `https://api.anthropic.com`, `https://api.openai.com/v1` and `https://generativelanguage.googleapis.com/v1beta`. With `headers` set and no key, no key header is sent, for gateways that authenticate by their own headers. `authStatus()` then reports the method as `Headers`.

### Retries

A request that gets a 429 or a 5xx answer (Anthropic's 529 included) is sent again, so a call goes out at most three times with the defaults. cli-funnel waits the time in the `Retry-After` header when there is one, and the backoff otherwise. If `Retry-After` asks for more than 30 seconds, there is no retry and the error comes back at once.

Retries happen only before any output. Once the response has started streaming, an error ends the run, because sending the request again would repeat text the caller already has. Network errors are not retried.

Each retry emits a `retry` event with `attempt`, `status` and `delayMs`, and `result.retries` holds the count. It is absent when nothing was retried. `retries` and `headers` also work on OpenAI-compatible endpoints, see [OpenAI-compatible servers](providers/openai-compatible.md).

## Prompt caching

Set `cache: true` on a run to use the Anthropic API's prompt cache. cli-funnel puts a `cache_control` breakpoint on the system prompt and on the newest turn, so the next turn in the session reads that prefix from the cache. The saving shows in `usage.cachedInputTokens`. Stored history is not changed. Models have a minimum prompt length for caching, and shorter prompts are simply not cached.

For Gemini, create cached content with Google's API and pass its name as `cachedContent: "cachedContents/abc123"` on a run. Gemini does not take a system prompt next to cached content, so put it in the cache. OpenAI caches long prompts on its own and has no setting, so `cache` and `cachedContent` are refused there. `capabilities.cache` says which providers take them.

## What they do and do not do

They stream text and report usage. They have no file access and no approvals, so `capabilities.access` is empty and `cwd` and `access` are ignored. The picker hides those controls. They run no tools of their own, but they can call tools your code defines, see [Tool calling](run-options.md#tool-calling).

Model lists come live from each vendor's `/models` endpoint, so they need a valid key. The OpenAI list leaves out models that only work with the Responses API (`-pro`, `-codex`, deep research) and aliases such as `chatgpt-4o-latest`. Fine-tuned `ft:` models stay.

Usage on the Anthropic API counts cache reads and cache writes in `inputTokens`, as Claude Code does, and reports the writes as `cacheCreationInputTokens`. `finishReason` is `denied` for a refusal and `length` for `max_tokens` or a full context window. The OpenAI API sends `responseSchema` with `strict: true`, so every object in the schema needs `additionalProperties: false` and all its properties listed in `required`. OpenAI-compatible servers get the schema without `strict`.

Error messages never carry a key. The configured key, `Bearer` values, `sk-` and `AIza` tokens and URL query strings are removed from them.

Conversation history for `sessionId` lives in the process memory by default, one store per `createFunnel()`. It is gone after a restart, and only the 500 most recently used sessions are kept. A turn that fails, is cancelled or ends early is not added, so the next turn in the session sends the same history again. A stream that closes before the vendor's end marker (`message_stop`, `[DONE]` or a finish reason) ends with an `error` event with code `stream-truncated`, and its partial text is not stored.

A session belongs to the provider that started it. The same `sessionId` on another provider starts a new conversation, because each provider stores messages in its own format. Turns on one session run one after another, and a turn is stored before its `done` event is yielded.

To keep sessions across restarts, pass a file store:

```ts
import { createFunnel, fileHistory } from "cli-funnel";

const funnel = createFunnel({ history: fileHistory("/path/to/sessions") });
```

`fileHistory` writes one JSON file per session, readable by the owner only, and keeps the 500 most recently written. It never removes a file written in the last 5 seconds, so a store can briefly hold a few more. For a database, pass any object with `get(key)` and `set(key, messages)`. The key is `<provider id>:<sessionId>`. Both may return a promise. The messages are in the provider's own format, so store them as they are. `cli-funnel run` and `cli-funnel serve` use a file store in `$XDG_STATE_HOME/cli-funnel/sessions`, or `~/.local/state/cli-funnel/sessions` when that variable is unset.

## Gemini API

`gemini-api` uses the Gemini API's `streamGenerateContent` with the key in the `x-goog-api-key` header. Get a key at aistudio.google.com.

- The model list comes from `models.list`. It keeps models that support `generateContent` and drops aliases such as `gemini-flash-latest`, embedding, TTS, image, video and live models.
- `responseSchema` goes to `generationConfig.responseJsonSchema`. Gemini supports a subset of JSON Schema: `$ref`, `anyOf`, `enum`, `properties`, `additionalProperties`, `required` and the usual type keywords.
- Thought parts, when the model sends them, become `reasoning.delta` events. Thinking tokens count as output tokens and also appear as `reasoningTokens`.
- A `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT` or `SPII` stop, or a blocked prompt, ends the run with `finishReason: "denied"`.
- Gemini 3 and later take an effort, sent as `thinkingLevel`. Gemini 2.5 models get none. See [Run options](run-options.md).
- The answer is stored with its `thoughtSignature`, and sent back on the next turn so the model keeps its reasoning.
- A `MALFORMED_FUNCTION_CALL` or `OTHER` stop ends the run with an `error` event.

Prefer passing the key through `apiKeys`. `agy` also reads `GEMINI_API_KEY` as a sign-in method, so the variable in the environment of a process that runs Antigravity may switch it to API billing.

For models on your own machine or server, see [Ollama](providers/ollama.md) and [OpenAI-compatible servers](providers/openai-compatible.md). They need no key unless the server asks for one.

## When to use a key

Use a key when many people share one deployment, when the work needs a service-level guarantee, or when the provider's subscription terms do not fit your product. See [Terms and limits](tos-notes.md).
