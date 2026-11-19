# Changelog

## 1.0.0

Antigravity runs over the Agent Client Protocol by default, and token counts follow one convention on every provider.

### Changed

- **Antigravity runs `agy acp` by default.** One process serves a conversation, `sessionId` resumes it by id, the model and thinking levels come from the account's session, `system` goes in the session's system prompt slot, and images are accepted. `providerOptions.antigravity.transport: "print"` keeps the 0.9.x way, one `agy --print` process per turn. The default needs agy 1.5.0 or newer. See [Antigravity](docs/providers/antigravity.md#transports).
- **`usage.inputTokens` includes the cached part on Antigravity**, as on the other providers. agy leaves its cache reads out of its own input count, so 0.9.x reported 3,571 input tokens where Claude Code, Codex and Cursor Agent would report 20,176 with `cachedInputTokens: 16605`. `totalTokens` is `inputTokens + outputTokens` everywhere, and the `Usage` type now says so.
- **Antigravity's capabilities.** `images: true`, `system: "native"` and `schema: "prompt"`. Over ACP there is no schema field, so `responseSchema` is asked for in the prompt and cli-funnel parses the reply. `print` still passes `--json-schema`.
- **Antigravity lists an `xhigh` effort** on the models that have one. 0.9.x did not group those ids into a model.
- A quota or rate limit that agy reports over ACP becomes a `limit` event with `resetAt`, then an `error`.

- **Antigravity `none` runs read less of the user's setup.** Over ACP they start with a private `--gemini-dir`, so the user's MCP servers do not start and their skills and global `GEMINI.md` are not read. On `print` the servers still start, and every call to them is refused. Both transports run in a folder that is the root of its own git repository, so the `AGENTS.md` and `.agents/` of a repository above it are not read.
- **MCP server values are masked wherever they show up.** Every header value and env value of a caller's `mcpServers`, whatever its name, and the password and the long query values of a server URL, are masked in events, raw events, the run log and error text.
- **A tool that fails at `none` without being refused stops the run.** On Antigravity and Cursor Agent, a forbidden call that ends in an error stops the run unless the error is the hook's or the permission answer's refusal, and so does a forbidden call that started and never ended by the end of the turn.
- **Antigravity takes MCP servers at `none` only off Windows.** On Windows the run is refused with `unsupported` until a live run there shows the deny hook working. `none` without servers is unchanged there, and `docs/access-levels.md` says it is unverified.
- **A run's folder at `none` is kept and put right every turn.** It is marked as in use and its hook file is rewritten before each turn, so another process's sweep cannot remove it from under a live session. A run that fails before agy starts removes its folder.
- **A caller's Codex server named like one in the user's config is refused** on every path, and `noToolsConfig` itself refuses it.
- **`none` runs of Antigravity and Cursor Agent drop `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR` and `GIT_CEILING_DIRECTORIES`** from the child's environment.
- **A refusal at `none` is told by text agy or cli-funnel writes, not by a tool's output.** Over ACP a tool's own output is never read as the hook's refusal: only the hook's exact text, our permission answer, or a failure with nothing in it counts.

### Added

- **`persist: false`** keeps a one-shot run out of the tool's saved history. It works on Claude Code (`--no-session-persistence`), Codex (an ephemeral thread) and the providers that keep history in cli-funnel's store, and `capabilities.ephemeral` says which. Cursor Agent and Antigravity have no way to skip saving and refuse the run with `unsupported`. It cannot be resumed, so it takes no `sessionId`. See [Runs that are not saved](docs/run-options.md#runs-that-are-not-saved).
- **`workspaceName`** (lowercase letters, digits, `_` and `-`, up to 40) gives an app its own folder for the access `none` runs of Cursor Agent and Antigravity, so its chats do not pile up in one folder shared by every app.

- **`mcpServers` at access `none`.** The model can call the tools of the servers you attach and nothing else: every built-in tool and every server of the user's own config stays off, and calls to your tools run without asking. `capabilities.mcpServersAtNone` lists the kinds (`http` and `stdio` on Claude Code, Codex and Antigravity over ACP). Cursor Agent cannot do it and refuses `mcpServers` at `none`. Verified live with a server that has one tool, a prompt that also asks for a file read and a shell command, and a check that only the tool ran. On Antigravity the servers go to agy under names with a random part for the run, a fixed deny hook that needs no script and is shown to work before the run starts lets through only the tools of those names, the user's own servers do not start (ACP), and a run stops with an error if a tool that should have been refused finishes. The generic `call_mcp_tool` is refused for every server there. See [Only your tools, at `none`](docs/run-options.md#only-your-tools-at-none).
- **`tool.start` carries `mcp: { server, tool }`** for a call to one of the run's `mcpServers`, whatever name the CLI gives the tool, and `RunResult.toolCalls` has the same field.

### Migrating from 0.9.x

1. Update agy to 1.5.0 or newer, or set `providerOptions.antigravity.transport: "print"` to stay on the old transport. `provider.detect()` says in `detail` when agy is too old.
2. If you add `cachedInputTokens` to `inputTokens` for Antigravity, stop: it is already in. Fresh input is `inputTokens - (cachedInputTokens ?? 0) - (cacheCreationInputTokens ?? 0)`.
3. If you use `forwardSubagentText` or `forwardSubagentTools` on Antigravity, set `transport: "print"`. The ACP transport refuses them with `unsupported`.
4. A run with `apiKey` on Antigravity uses `print` unless you say otherwise. `transport: "acp"` with `apiKey` fails with `unsupported`.
5. Antigravity no longer sends `access.reduced` at `full`. A session started with `--dangerously-skip-permissions` still reports mode `default` over ACP, so there is nothing to compare.
6. `providerOptions.claude.ephemeral` and `providerOptions.codex.ephemeral` still work. `persist: false` is the same thing for every provider.
7. `none` used to refuse `mcpServers` and run with no MCP at all. It now accepts them where `capabilities.mcpServersAtNone` lists the kind, so a caller that relied on the refusal needs to stop passing the servers. A caller server whose name starts with `clifunnel` and a `toolTimeoutSec` on an Antigravity ACP server are refused. A `workspaceName` must be lowercase.
8. Check code that reads `capabilities.schema === "native"` or `capabilities.images === false` for Antigravity.
