# Concepts

## What cli-funnel does

Claude Code, Codex, Cursor Agent and Antigravity each run headless with their own flags, event formats and login commands. cli-funnel starts the real CLI binary as a child process, translates its output into one event format, and gives you one way to sign in, update and pick settings.

The same interface also covers providers that spawn nothing: the Anthropic, OpenAI and Gemini APIs with a key, an Ollama server, and any OpenAI-compatible server. They have no machine access, so `access` and `cwd` do not apply to them.

Because the real binary runs, the work counts against the subscription that CLI is signed in to. cli-funnel never reads or copies OAuth tokens. It never calls a provider's private endpoints. It does not pass `claude --bare`, which would disable subscription login.

## The pieces

A **provider** wraps one CLI. It knows the binary name, how to build flags from a selection, how to parse the output, and how to sign in and update.

A **selection** is one plain object with everything a user chooses: provider, model, reasoning effort, context window, fast mode, project folder and access level. Your UI produces it. You can also write it by hand and hardcode it. See [Selection](selection.md).

An **event** is one step of a run: `session`, `text.delta`, `reasoning.delta`, `tool.start`, `tool.end`, `approval.request`, `usage`, `done`, `error`. Every provider emits the same events.

A **result** is what `funnel.run()` resolves to once the events are folded together. It is shaped like an API response.

## Capabilities

The CLIs do not all support the same things, and cli-funnel does not pretend they do. Each provider declares its capabilities: the access levels it can enforce, and whether it has effort, context window and fast mode settings. A selection that asks for something unsupported fails validation with a message that names the limit. UIs read the same declaration and hide controls that would do nothing.

## Two integration paths

Use the library in a Node, Bun or Electron process. Or run `cli-funnel serve` and talk to it over HTTP. The server exposes the funnel routes for UIs and OpenAI-compatible endpoints for existing SDKs.
