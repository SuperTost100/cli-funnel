# Run options

Besides `selection` and `prompt`, a run takes a few optional fields. They cover what an app needs when it uses a CLI as a plain model: instructions, images, JSON answers, an output limit and sampling.

```ts
const result = await funnel.run({
  selection: { provider: "claude", model: "claude-sonnet-5", cwd: scratchDir, access: "none" },
  system: "You are a physics tutor. Answer in Italian.",
  prompt: "What color is this graph's curve?",
  attachments: [{ type: "image", mediaType: "image/png", data: base64Png }],
  responseSchema: { schema: { type: "object", properties: { color: { type: "string" } }, required: ["color"], additionalProperties: false } },
  maxOutputTokens: 2000,
  sampling: { temperature: 0.2, stop: ["###"] },
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
| `cache` | refused | refused | refused | refused | `cache_control` on the system prompt and newest turn | refused | no effect | refused |
| `cachedContent` | refused | refused | refused | refused | refused | refused | `cachedContent` | refused |
| `sampling.temperature` | refused | refused | refused | refused | `temperature` | `temperature` | `generationConfig.temperature` | `options.temperature` |
| `sampling.topP` | refused | refused | refused | refused | `top_p` | `top_p` | `generationConfig.topP` | `options.top_p` |
| `sampling.stop` | refused | refused | refused | refused | `stop_sequences` | `stop` | `generationConfig.stopSequences` | `options.stop` |
| `sampling.seed` | refused | refused | refused | refused | ignored, the API has no seed | `seed` | `generationConfig.seed` | `options.seed` |

When an API provider or model server stops because it hit the output limit, the run ends with `finishReason: "length"` and `text` is cut off. With `responseSchema`, a cut-off answer usually fails to parse and `structuredError` says so. The CLIs never report `length`.

OpenAI-compatible servers send the same fields as the OpenAI API, except `max_tokens` for the output limit. See [OpenAI-compatible servers](providers/openai-compatible.md).

`capabilities.system`, `capabilities.images`, `capabilities.schema` and `capabilities.sampling` say the same thing in code. A run with attachments on a provider without `images`, or with `sampling` on a provider without `sampling`, fails with `unsupported` before the CLI starts.

## Sampling

`sampling` is `{ temperature, topP, stop, seed }`, all optional. Fields you leave out are not sent, so the vendor default applies. A value of `0` is sent as `0`.

cli-funnel does not check values against what a model allows. The vendor does, and its error comes back as an `error` event. Recent Claude models (Opus 4.7 and later, Sonnet 5 and later, Haiku 5.5, Fable, Mythos) reject a non-default `temperature` or `top_p`. OpenAI reasoning models reject `temperature` other than the default. Leave `sampling` out for them.

## Effort on the API providers

Set `selection.effort` to one of the ids in `model.efforts`. The vendor model lists carry no effort data, so `src/providers/efforts.ts` holds a small table by model id:

| Provider | Models with effort | Levels | Request |
|---|---|---|---|
| `anthropic-api` | Opus 4.5 and later, Sonnet 4.6 and later, Haiku 5 and later, Fable, Mythos | `low`, `medium`, `high`, plus `xhigh` and `max` where the model has them | `output_config.effort`, and `thinking: { type: "adaptive", display: "summarized" }` |
| `openai-api` | the o-series (not `o1-mini`, `o1-preview`) and `gpt-5` onward (not chat or search variants) | `low`, `medium`, `high` | `reasoning_effort` |
| `gemini-api` | Gemini 3 and later | `low`, `medium`, `high` (`low`, `high` on Gemini 3 Pro) | `generationConfig.thinkingConfig` with `thinkingLevel` and `includeThoughts` |

A model that is not in the table, such as a release newer than this version, has no effort setting. Pass `allowUnlistedModels: true` to `createFunnel` to skip the per-model check. The effort string then goes to the vendor as you wrote it, so `minimal` or a level added later works.

Thinking text arrives as `reasoning.delta` events. The Anthropic API returns it only when you set an effort, because the newest models hide it by default (`display: "omitted"`). Opus 4.5 takes `effort` but not adaptive thinking, so it sends no thinking text. Gemini 2.5 models take a token budget, not a level, and get no effort setting. Chat Completions does not stream reasoning summaries, so OpenAI sends no `reasoning.delta`.

## Sessions

`sessionId` continues an earlier conversation. Each turn starts a new CLI process unless the funnel keeps processes alive. See [Live sessions](sessions.md).

## Structured answers

When `responseSchema` is set, `result.structured` holds the parsed answer. Claude Code and Antigravity report it themselves. For the others cli-funnel parses the answer text, and a surrounding code fence is allowed. If the text is not JSON, `structured` is empty and `result.structuredError` says why.

cli-funnel does not validate the answer against the schema. `schema: "native"` means the vendor enforces it. `schema: "prompt"` means the model was only asked. Validate either way before you trust it.

Codex, the Anthropic API and the OpenAI API need `additionalProperties: false` on every object in the schema. The OpenAI API also needs every property in `required`, because it enforces the schema with `strict: true`.

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

## Cancel a run

In the library, abort the `signal` you passed to `stream()` or `run()`. The provider stops and the stream ends with `done` and `finishReason: "cancelled"`.

Over HTTP, the first event on `/run` is `{ type: "run", runId }`. Cancel the run with:

```bash
curl -X POST http://127.0.0.1:4747/runs/<runId>/cancel
```

The server stops the provider and answers any approval the run is waiting on with `deny`. The stream then ends with `done` and `finishReason: "cancelled"`. A run id the server does not know, or one that has already finished, gets a 404.

From the browser client, call `client.cancelRun(runId)`. `useRun().cancel()` calls it and also closes the local stream.

Chat completions report the id in `x_funnel.runId`. A streaming response carries it in the first chunk, so an SDK client can cancel while the answer is still coming. The same route works for both.

Closing the connection still cancels the run, as before.

## Deadline

`timeoutMs` stops a run that takes too long, whatever the provider:

```ts
const result = await funnel.run({ selection, prompt, timeoutMs: 120_000 });

if (result.timeout) console.log("Gave up after 2 minutes. Partial answer:", result.text);
```

When the deadline passes, cli-funnel aborts the provider and ends the run without waiting for it. The stream ends with `{ type: "done", finishReason: "cancelled", timeout: true }`, and the result has `finishReason: "cancelled"` and `timeout: true`. It is not an error, and `text` keeps what arrived before the deadline. The CLI gets SIGTERM, and SIGKILL 3 seconds later if it is still running, so a hung CLI does not outlive its run.

| Where | Option | Default |
|---|---|---|
| Library | `RunInput.timeoutMs` | none |
| HTTP handler | `createHandler(funnel, { maxRunMs })`, applied to `/run` and `/v1/chat/completions` | none |
| `cli-funnel run` | `--timeout <seconds>` | none |
| `cli-funnel serve` | `--timeout <seconds>`, sets `maxRunMs` | 1800 (30 minutes). `0` turns it off. |

`cli-funnel run` exits with code 1 when it hits the deadline.
