# Quickstart

You need Node 22 or newer and at least one supported CLI installed and signed in. Check with:

```bash
npx cli-funnel doctor
```

`doctor` lists each CLI, its version, whether the version is inside the range this release was tested against, and whether you are signed in.

## Install

```bash
npm install cli-funnel
```

## Run a prompt

```ts
import { createFunnel } from "cli-funnel";

const funnel = createFunnel();

const result = await funnel.run({
  selection: {
    provider: "claude",
    model: "claude-sonnet-5",
    cwd: "/path/to/your/project",
    access: "accept-edits",
  },
  prompt: "Add a unit test for parseConfig",
});

console.log(result.text);
console.log(result.usage);
```

`result` has the same fields whichever provider ran: `text`, `usage`, `sessionId`, `model`, `finishReason`, `toolCalls`, `deniedActions`.

To continue the conversation, pass `sessionId: result.sessionId` in the next call.

## Stream

```ts
const stream = funnel.stream({ selection, prompt });

for await (const event of stream) {
  if (event.type === "text.delta") process.stdout.write(event.text);
  if (event.type === "tool.start") console.log("tool:", event.name);
}

const result = await stream.result;
```

## Watch runs

Pass `onEvent` to see every event of every run, with its run id, provider, model and timestamp. Use it for metrics or an audit trail:

```ts
const funnel = createFunnel({
  onEvent: ({ runId, provider, event }) => console.log(runId, provider, event.type),
});
```

It is never awaited and cannot break a run. `jsonlRunLog` writes one line per run to a file. See [Log runs](serve.md#log-runs) for the fields and what is left out by default.

## Run from a terminal

```bash
npx cli-funnel run claude claude-sonnet-5 "Summarize this repo"
```

Pass `-` as the prompt, or no prompt, to read it from stdin. Use this for long prompts and for output from other commands:

```bash
cat spec.md | npx cli-funnel run claude claude-sonnet-5 -
```

Options for scripts:

| Flag | Effect |
|---|---|
| `--image <file>` | Attaches a PNG, JPEG, WebP or GIF. Repeat it for more images. The type comes from the file contents. |
| `--schema <file.json>` | Asks for an answer that matches the JSON Schema in the file, and prints only that answer. Exits with 1 and says why on stderr when there is none. |
| `--json` | Prints only the result object on stdout. The text is not streamed. Tool markers go to stderr. |
| `--quiet` | Drops the stream. Alone, it prints the final text once. With `--json`, stderr stays empty apart from the session id. |

The session id is always on stderr, so stdout can go straight into `jq`:

```bash
npx cli-funnel run claude claude-sonnet-5 "Name the color of this curve" --image graph.png --schema color.json --quiet | jq .color
```

Not every provider takes images or enforces a schema. See [Run options](run-options.md). With `--access supervised` the prompt has to be an argument, because approvals are asked on the terminal.

## Pick a model

Model ids are always concrete, versioned names. There is no "latest" alias. List what your CLI offers today:

```ts
const models = await funnel.models("claude");
// [{ id, name, efforts, contextWindows, fast, ... }]
```

or from a terminal:

```bash
npx cli-funnel models codex
```

## Ask before every action

`supervised` access pauses each risky tool call and asks you. Pass an `onApproval` callback:

```ts
await funnel.run({
  selection: { ...selection, access: "supervised" },
  prompt,
  onApproval: async (request) => {
    console.log(request.tool, request.input);
    return "allow"; // or "deny"
  },
});
```

Not every CLI can pass approvals through. `funnel.providers.<id>.capabilities.access` lists what each one can enforce. Levels a CLI cannot enforce are not offered, and asking for one throws.

## Use it from a browser or another language

```bash
npx cli-funnel serve --cwd /path/to/project
```

This starts an HTTP server with an OpenAI-compatible `/v1/chat/completions`. See [Run the server](serve.md), [OpenAI compatibility](openai-compat.md) and [UI components](ui.md).
