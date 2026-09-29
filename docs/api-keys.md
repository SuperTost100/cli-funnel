# API keys

Two providers call the vendor APIs directly and return the same events and result shape as the CLI providers. Switch between a subscription and a key by changing `selection.provider`.

| Provider id | Key |
|---|---|
| `anthropic-api` | `ANTHROPIC_API_KEY` |
| `openai-api` | `OPENAI_API_KEY` |

```ts
const funnel = createFunnel({ apiKeys: { anthropic: process.env.MY_KEY } });

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

## When to use a key

Use a key when many people share one deployment, when the work needs a service-level guarantee, or when the provider's subscription terms do not fit your product. See [Terms and limits](tos-notes.md).
