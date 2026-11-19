# Changelog

## 1.0.0

Antigravity runs over the Agent Client Protocol by default, and token counts follow one convention on every provider.

### Changed

- **Antigravity runs `agy acp` by default.** One process serves a conversation, `sessionId` resumes it by id, the model and thinking levels come from the account's session, `system` goes in the session's system prompt slot, and images are accepted. `providerOptions.antigravity.transport: "print"` keeps the 0.9.x way, one `agy --print` process per turn. The default needs agy 1.5.0 or newer. See [Antigravity](docs/providers/antigravity.md#transports).
- **`usage.inputTokens` includes the cached part on Antigravity**, as on the other providers. agy leaves its cache reads out of its own input count, so 0.9.x reported 3,571 input tokens where Claude Code, Codex and Cursor Agent would report 20,176 with `cachedInputTokens: 16605`. `totalTokens` is `inputTokens + outputTokens` everywhere, and the `Usage` type now says so.
- **Antigravity's capabilities.** `images: true`, `system: "native"` and `schema: "prompt"`. Over ACP there is no schema field, so `responseSchema` is asked for in the prompt and cli-funnel parses the reply. `print` still passes `--json-schema`.
- **Antigravity lists an `xhigh` effort** on the models that have one. 0.9.x did not group those ids into a model.
- A quota or rate limit that agy reports over ACP becomes a `limit` event with `resetAt`, then an `error`.

### Migrating from 0.9.x

1. Update agy to 1.5.0 or newer, or set `providerOptions.antigravity.transport: "print"` to stay on the old transport. `provider.detect()` says in `detail` when agy is too old.
2. If you add `cachedInputTokens` to `inputTokens` for Antigravity, stop: it is already in. Fresh input is `inputTokens - cachedInputTokens - (cacheCreationInputTokens ?? 0)`.
3. If you use `forwardSubagentText` or `forwardSubagentTools` on Antigravity, set `transport: "print"`. The ACP transport refuses them with `unsupported`.
4. A run with `apiKey` on Antigravity uses `print` unless you say otherwise. `transport: "acp"` with `apiKey` fails with `unsupported`.
5. Antigravity no longer sends `access.reduced` at `full`. A session started with `--dangerously-skip-permissions` still reports mode `default` over ACP, so there is nothing to compare.
6. Check code that reads `capabilities.schema === "native"` or `capabilities.images === false` for Antigravity.
