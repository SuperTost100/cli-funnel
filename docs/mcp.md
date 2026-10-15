# MCP server

`cli-funnel mcp` runs an MCP server on stdio. An agent that speaks MCP, such as Claude Code, Codex or Cursor, can then call another provider as a tool: ask Codex from inside Claude Code, or send a cheap question to a local Ollama model.

```bash
npx cli-funnel mcp
```

The server answers `initialize`, `ping`, `tools/list` and `tools/call`. It speaks protocol revisions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, and picks the one the client asks for. It needs no extra dependency. Stdout carries protocol messages only. Logs go to stderr.

## Add it to a client

The client starts the server itself. You do not run it by hand.

Claude Code:

```bash
claude mcp add cli-funnel -- npx cli-funnel mcp
```

Codex:

```bash
codex mcp add cli-funnel -- npx cli-funnel mcp
```

Cursor, in `.cursor/mcp.json` for one project or `~/.cursor/mcp.json` for all of them:

```json
{
  "mcpServers": {
    "cli-funnel": {
      "command": "npx",
      "args": ["cli-funnel", "mcp"]
    }
  }
}
```

Put flags after `mcp`, for example `"args": ["cli-funnel", "mcp", "--max-access", "accept-edits"]`.

## Tools

| Tool | Input | Result |
|---|---|---|
| `list_providers` | none | Each provider with `installed`, `loggedIn`, `version` and the `access` levels it can enforce, plus the server's `maxAccess` |
| `list_models` | `provider` | The provider's models, with effort levels, context sizes and fast tier |
| `run` | `selection`, `prompt`, `system`, `responseSchema` | The final answer, once the run ends |

`selection` has `provider` and `model`, and optionally `effort`, `contextWindow`, `fast`, `cwd` and `access`. See [Selection](selection.md). Without `cwd` a run uses the folder the server started in. Without `access` it uses `none`.

`responseSchema` is `{ "schema": { ... } }`, the same as in [Run options](run-options.md#structured-answers). The parsed answer comes back in `structured`.

The `run` result has a text block with the answer. From revision 2025-06-18 on it also has `structuredContent`, shaped like the `RunResult` of `funnel.run()`: `text`, `provider`, `model`, `sessionId`, `usage`, `finishReason`, `toolCalls`, `deniedActions` and `structured`. A failed run, a refused run and bad arguments come back as a result with `isError: true` and the reason in the text, so the calling model can read it and adjust.

## Limit what a run can do

`--max-access <level>` sets the highest access level a `run` may ask for. The default is `none`: text in, text out, no file writes and no commands. A run that asks for more is refused with an error that names the cap. The server never lowers the level silently.

```bash
npx cli-funnel mcp --max-access accept-edits
```

The levels are in [Access levels](access-levels.md). `supervised` is always refused. It needs the server to ask you for each approval, and that needs MCP elicitation, which this version does not have. Use `none` for a read-only helper, or a higher level you trust.

A run also needs a project folder inside the allowed folders. The default is the home directory plus the folder the server started in. `--fs-root <dir>` replaces that list and can repeat. A folder outside the list, a relative path, a path that does not exist and a symlink that leads out are all refused. This is the same check as `fsRoots` on the [HTTP server](ui.md).

```bash
npx cli-funnel mcp --fs-root ~/code --fs-root ~/notes
```

`--cwd <dir>` sets the folder that runs use when they name none.

## Limits

This is the first version.

- Stdio only. There is no `--transport http` yet.
- No `status` or `cancel` tool, and no streaming. `run` waits for the whole answer. A client can still cancel with the protocol's `notifications/cancelled`, and closing stdin ends every run in progress.
- No approval forwarding, so no `supervised` access.
- A run costs what it costs on the provider: subscription usage for the CLIs, credit for the API providers. Access `none` also keeps it small.
- Providers come from the same setup as the rest of cli-funnel, including `CLI_FUNNEL_OPENAI_COMPATIBLE` and the API key variables. See [API keys](api-keys.md).
