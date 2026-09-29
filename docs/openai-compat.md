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

Ids are `<provider>/<model>`, for example `claude/claude-sonnet-5` or `codex/gpt-5.3-codex`. `GET /v1/models` lists every model from every installed provider.

## Mapping

| OpenAI field | cli-funnel |
|---|---|
| `messages` | Flattened into one prompt. With a session id, only the last user message is sent. |
| `stream: true` | Server-sent events, ending with `[DONE]`. |
| `reasoning_effort` | `selection.effort` |
| `usage.prompt_tokens`, `completion_tokens`, `total_tokens` | From the CLI's usage report, when it gives one. |

## Extensions

Chat completions cannot carry a folder or an access level, so the server takes them from its flags. Override per request with `x_funnel`:

```json
{ "x_funnel": { "cwd": "/path", "access": "full", "sessionId": "abc", "fast": true, "contextWindow": 1000000 } }
```

The response carries `x_funnel.sessionId`, `toolCalls` and `deniedActions`. Send the session id back to continue the conversation.

## Limits

The OpenAI wire format has no approve button. Requests to this endpoint therefore deny anything that needs approval, and `supervised` behaves as deny-by-default. Use `accept-edits`, `auto` or `full` here, or use the `/run` route and `useRun` when a human should approve actions.

Tool calls happen inside the CLI. They do not appear as OpenAI `tool_calls`.
