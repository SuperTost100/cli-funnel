# Run options

Besides `selection` and `prompt`, a run takes four optional fields. They cover what an app needs when it uses a CLI as a plain model: instructions, images, JSON answers and an output limit.

```ts
const result = await funnel.run({
  selection: { provider: "claude", model: "claude-sonnet-5", cwd: scratchDir, access: "none" },
  system: "You are a physics tutor. Answer in Italian.",
  prompt: "What color is this graph's curve?",
  attachments: [{ type: "image", mediaType: "image/png", data: base64Png }],
  responseSchema: { schema: { type: "object", properties: { color: { type: "string" } }, required: ["color"], additionalProperties: false } },
  maxOutputTokens: 2000,
});

result.structured; // { color: "rosso" }
```

## What each provider does

| | Claude Code | Codex | Cursor Agent | Antigravity | Anthropic API | OpenAI API | Gemini API | Ollama |
|---|---|---|---|---|---|---|---|---|
| `system` | `--system-prompt` at `none`, `--append-system-prompt` otherwise | `developerInstructions` | put in front of the prompt | put in front of the prompt | `system` | a system message | `systemInstruction` | a system message |
| `attachments` | image blocks in the stream-json message | `image` input items | refused | refused | image blocks | `image_url` parts | `inlineData` parts | `images` on the message |
| `responseSchema` | `--json-schema` | `outputSchema` | asked for in the prompt | `--json-schema` | `output_config.format` | `response_format` | `responseJsonSchema` | `format` |
| `maxOutputTokens` | ignored | ignored | ignored | ignored | `max_tokens` | `max_completion_tokens` | `maxOutputTokens` | `options.num_predict` |

`capabilities.system`, `capabilities.images` and `capabilities.schema` say the same thing in code. A run with attachments on a provider without `images` fails with `unsupported` before the CLI starts.

## Structured answers

When `responseSchema` is set, `result.structured` holds the parsed answer. Claude Code and Antigravity report it themselves. For the others cli-funnel parses the answer text, and a surrounding code fence is allowed. If the text is not JSON, `structured` is empty and `result.structuredError` says why.

cli-funnel does not validate the answer against the schema. `schema: "native"` means the vendor enforces it. `schema: "prompt"` means the model was only asked. Validate either way before you trust it.

Codex and the Anthropic API need `additionalProperties: false` on every object in the schema.

## Text only: access `none`

`none` is for apps that want a model, not an agent. Nothing on the machine changes: no file writes, no commands, no MCP tool calls. Point `cwd` at an empty folder anyway, since some CLIs can still read files.

| CLI | How `none` is enforced | One-line prompt, input tokens |
|---|---|---|
| Claude Code | `--tools ""`, `--strict-mcp-config`, `--setting-sources ""` | about 21,800 before, about 400 after |
| Codex | read-only sandbox, every approval denied, tool features and config MCP servers switched off | about 19,000 before, about 11,900 after |
| Cursor Agent | runs in a cli-funnel folder whose `.cursor/cli.json` denies every tool, plus `--mode ask` | about 13,900 before, about 16,200 after |
| Antigravity | runs in a cli-funnel folder whose `.agents/hooks.json` denies every tool call | about 15,700 before and after |

Removing settings also stops Claude Code from loading the user's CLAUDE.md, hooks and skills. That is where most of the saved tokens come from.

Cursor Agent and Antigravity have no flag that removes tools. Their read-only modes still ran shell commands in testing. Both read config files from the folder they run in, so at `none` cli-funnel ignores `cwd` and runs them in a folder it owns under `~/.cache/cli-funnel/workspaces/` (or `$XDG_CACHE_HOME`). That folder holds one file:

- Cursor Agent: `.cursor/cli.json` with deny rules for `Shell(*)`, `Read(**)`, `Write(**)`, `WebFetch(*)` and `Mcp(*:*)`. A deny rule beats every allow rule, the user's approval mode and `--force`. Grep and glob stay inside the folder, which is empty.
- Antigravity: `.agents/hooks.json` with a `PreToolUse` hook that answers `deny` for every tool except `finish`, which carries the `--json-schema` answer. A deny beats an `allow` from any other hook, and a hook that fails also blocks the call.

The model still sees its tools and may try one. The call fails, shows up in `result.deniedActions`, and the model answers in text. Neither CLI drops the tool definitions, so the token count does not go down. Antigravity still starts MCP servers from the user's config, but every call to them is refused. Project files such as `AGENTS.md` are not loaded, since the run does not happen in `cwd`. See [Access levels](access-levels.md).
