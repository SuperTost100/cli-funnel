# Selection

A selection describes one run. It is plain JSON, so you can store it, send it over the network, or paste it into code.

```ts
interface Selection {
  provider: "claude" | "codex" | "agent" | "antigravity";
  model: string;          // concrete id, for example "claude-sonnet-5"
  effort?: string;        // one of the model's efforts
  contextWindow?: number; // tokens, one of the model's contextWindows
  fast?: boolean;         // only when the model has a fast tier
  cwd: string;            // absolute path of the project
  access: "none" | "supervised" | "accept-edits" | "auto" | "full";
}
```

## Where model lists come from

Model ids are never aliases. The list for each provider is built from two sources, and the CLI wins when both name the same id. Model servers are the exception: Ollama and OpenAI-compatible lists come only from the server, and ids such as `qwen3:latest` are passed through as the server names them. See [Ollama](providers/ollama.md) and [OpenAI-compatible servers](providers/openai-compatible.md).

1. The CLI itself, when it can list models. Codex, Cursor Agent and Antigravity can.
2. A manifest in `data/models/<provider>.json`, verified against the real CLI by the contract tests. Claude Code has no list command, so its list comes only from here.

The manifest can refresh without a package release. Point `manifestUrl` at a hosted copy:

```ts
createFunnel({ manifestUrl: "https://example.com/cli-funnel/models.json" });
```

An entry can carry `minCliVersion`, which hides the model on older CLIs.

A model released after your manifest still runs if you set `allowUnlistedModels: true`. The id goes to the CLI unchanged.

## Hardcode or expose

Hardcode the whole selection when your app has one fixed setup:

```ts
await funnel.run({ selection: { provider: "codex", model: "gpt-5.3-codex", effort: "high", cwd, access: "full" }, prompt });
```

Or let users choose some fields and lock the rest. `FunnelPicker` takes `locked` and hides those controls:

```tsx
<FunnelPicker client={client} locked={{ provider: "claude", access: "supervised" }} onChange={setSelection} />
```

## Validation

`validateSelection` runs before every call. It rejects an unknown model, an effort the model lacks, a fast flag on a model with no fast tier, a context size the model does not offer, an access level the provider cannot enforce, and a `cwd` that is not an existing absolute directory. The error message says which rule failed and lists valid values.
