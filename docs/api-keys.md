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

## What they do and do not do

They stream text and report usage. They have no tools, no file access and no approvals, so `capabilities.access` is empty and `cwd` and `access` are ignored. The picker hides those controls.

Model lists come live from each vendor's `/models` endpoint, so they need a valid key.

Conversation history for `sessionId` lives in the process memory. It is gone after a restart.

## Gemini API

`gemini-api` uses the Gemini API's `streamGenerateContent` with the key in the `x-goog-api-key` header. Get a key at aistudio.google.com.

- The model list comes from `models.list`. It keeps models that support `generateContent` and drops aliases such as `gemini-flash-latest`, embedding, TTS, image, video and live models.
- `responseSchema` goes to `generationConfig.responseJsonSchema`. Gemini supports a subset of JSON Schema: `$ref`, `anyOf`, `enum`, `properties`, `additionalProperties`, `required` and the usual type keywords.
- Thought parts, when the model sends them, become `reasoning.delta` events. Thinking tokens count as output tokens and also appear as `reasoningTokens`.
- A `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT` or `SPII` stop, or a blocked prompt, ends the run with `finishReason: "denied"`.
- Effort is not offered. The model's default thinking level applies.

Prefer passing the key through `apiKeys`. `agy` also reads `GEMINI_API_KEY` as a sign-in method, so the variable in the environment of a process that runs Antigravity may switch it to API billing.

For models on your own machine or server, see [Ollama](providers/ollama.md) and [OpenAI-compatible servers](providers/openai-compatible.md). They need no key unless the server asks for one.

## When to use a key

Use a key when many people share one deployment, when the work needs a service-level guarantee, or when the provider's subscription terms do not fit your product. See [Terms and limits](tos-notes.md).
