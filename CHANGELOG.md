# Changelog

## 1.0.0

Antigravity runs over the Agent Client Protocol by default, and token counts follow one convention on every provider.

### Changed

- **Antigravity runs `agy acp` by default.** One process serves a conversation, `sessionId` resumes it by id, the model and thinking levels come from the account's session, `system` goes in the session's system prompt slot, and images are accepted. `providerOptions.antigravity.transport: "print"` keeps the 0.9.x way, one `agy --print` process per turn. The default needs agy 1.5.0 or newer. See [Antigravity](docs/providers/antigravity.md#transports).
- **`usage.inputTokens` includes the cached part on Antigravity**, as on the other providers. agy leaves its cache reads out of its own input count, so 0.9.x reported 3,571 input tokens where Claude Code, Codex and Cursor Agent would report 20,176 with `cachedInputTokens: 16605`. `totalTokens` is `inputTokens + outputTokens` everywhere, and the `Usage` type now says so.
- **Antigravity's capabilities.** `images: true`, `system: "native"` and `schema: "prompt"`. Over ACP there is no schema field, so `responseSchema` is asked for in the prompt and cli-funnel parses the reply. `print` still passes `--json-schema`.
- **Antigravity lists an `xhigh` effort** on the models that have one. 0.9.x did not group those ids into a model.
- A quota or rate limit that agy reports over ACP becomes a `limit` event with `resetAt`, then an `error`.

### Added

- **`persist: false`** keeps a one-shot run out of the tool's saved history. It works on Claude Code (`--no-session-persistence`), Codex (an ephemeral thread) and the providers that keep history in cli-funnel's store, and `capabilities.ephemeral` says which. Cursor Agent and Antigravity have no way to skip saving and refuse the run with `unsupported`. It cannot be resumed, so it takes no `sessionId`. See [Runs that are not saved](docs/run-options.md#runs-that-are-not-saved).
- **`workspaceName`** gives an app its own folder for the access `none` runs of Cursor Agent and Antigravity, so its chats do not pile up in one folder shared by every app.

- **`mcpServers` at access `none`.** The model can call the tools of the servers you attach and nothing else: every built-in tool and every server of the user's own config stays off, and calls to your tools run without asking. `capabilities.mcpServersAtNone` lists the kinds (`http` and `stdio` on all four CLIs). Verified live on each with a server that has one tool, a prompt that also asks for a file read and a shell command, and a check that only the tool ran. See [Only your tools, at `none`](docs/run-options.md#only-your-tools-at-none).
- **`tool.start` carries `mcp: { server, tool }`** for a call to one of the run's `mcpServers`, whatever name the CLI gives the tool, and `RunResult.toolCalls` has the same field.

### Migrating from 0.9.x

1. Update agy to 1.5.0 or newer, or set `providerOptions.antigravity.transport: "print"` to stay on the old transport. `provider.detect()` says in `detail` when agy is too old.
2. If you add `cachedInputTokens` to `inputTokens` for Antigravity, stop: it is already in. Fresh input is `inputTokens - cachedInputTokens - (cacheCreationInputTokens ?? 0)`.
3. If you use `forwardSubagentText` or `forwardSubagentTools` on Antigravity, set `transport: "print"`. The ACP transport refuses them with `unsupported`.
4. A run with `apiKey` on Antigravity uses `print` unless you say otherwise. `transport: "acp"` with `apiKey` fails with `unsupported`.
5. Antigravity no longer sends `access.reduced` at `full`. A session started with `--dangerously-skip-permissions` still reports mode `default` over ACP, so there is nothing to compare.
6. `providerOptions.claude.ephemeral` and `providerOptions.codex.ephemeral` still work. `persist: false` is the same thing for every provider.
7. `none` used to refuse `mcpServers` and run with no MCP at all. It now accepts them where `capabilities.mcpServersAtNone` lists the kind, so a caller that relied on the refusal needs to stop passing the servers.
8. Check code that reads `capabilities.schema === "native"` or `capabilities.images === false` for Antigravity.
