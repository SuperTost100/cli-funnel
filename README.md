# cli-funnel

Use Claude Code, Codex, Cursor Agent and Antigravity like an API. Same call, same output, on the subscription you already pay for.

```ts
import { createFunnel } from "cli-funnel";

const funnel = createFunnel();

const result = await funnel.run({
  selection: {
    provider: "claude",
    model: "claude-sonnet-5",
    cwd: "/path/to/project",
    access: "accept-edits",
  },
  prompt: "Find the bug in src/parse.ts and fix it",
});

result.text;   // the answer
result.usage;  // { inputTokens, outputTokens, ... }
```

Switch `provider` to `codex`, `agent` or `antigravity` and nothing else in your code changes. Switch it to `anthropic-api` or `openai-api` to use a key instead.

## Why

Each of these CLIs runs headless, but every one has its own flags, its own event format, its own login command and its own way of listing models. If you want your app to work with all of them, you write four integrations and rewrite parts every time a CLI ships. cli-funnel is that work, done once and kept in one folder per CLI.

It starts the real binary. Your runs count against the login the CLI already has, not against an API bill.

## What you get

- One event stream and one result shape for every provider. API-key providers return the same thing, so mixing keys and subscriptions needs no changes downstream.
- Sign-in, sign-out and update passthrough. Your UI shows the sign-in link and a one-click update button. The CLI does the real work.
- Settings as one object. Model, reasoning effort, fast mode, project folder and access level live in a `Selection` that a UI produces or you hardcode.
- Model lists with concrete versioned ids. No "latest" aliases, so a run always says which model it used.
- An approve button for supervised runs, where the CLI supports one.
- An OpenAI-compatible server. Point any OpenAI SDK at it.
- React hooks and a picker, a login panel and an approval prompt.

## What each CLI can do

| | Claude Code | Codex | Cursor Agent | Antigravity |
|---|---|---|---|---|
| No tools (`none`) | yes | yes | no | no |
| Supervised (approve each action) | yes | yes | no | no |
| Accept edits | yes | yes | no | yes |
| Auto | yes | yes | yes | no |
| Full access | yes | yes | yes | yes |
| Reasoning effort | yes | yes | yes | yes |
| Fast mode | no | yes | yes | no |
| Live model list | no, bundled | yes | yes | yes |
| Resume a conversation | yes | yes | yes | yes |
| System prompt | yes | yes | in the prompt | in the prompt |
| Image input | yes | yes | no | no |
| JSON schema output | yes | yes | in the prompt | yes |
| Sign-in from your UI | link | link | link | terminal handoff |

Every "no" in this table is a limit of the CLI, not of cli-funnel. cli-funnel does not fake a feature. When a CLI cannot enforce something headlessly, the option is not offered. [Access levels](docs/access-levels.md) explains each gap.

No CLI exposes a selectable context window today. When one does, the picker shows it.

## Install

You need Node 22 or newer and at least one CLI signed in.

```bash
npm install cli-funnel
npx cli-funnel doctor
```

`doctor` shows which CLIs it found, their versions, and whether you are signed in.

Apps started from the macOS Dock or a Linux desktop launcher get a minimal PATH. cli-funnel reads the PATH from your login shell once, searches it for the CLIs, and passes it to every CLI it starts, so tools installed through nvm, asdf, pnpm or Homebrew work from a GUI app. Set `CLI_FUNNEL_NO_SHELL_PATH=1` to skip that, or `CLI_FUNNEL_<BINARY>_BIN` to point at one binary directly.

## Use it from a terminal

```bash
npx cli-funnel models codex
npx cli-funnel run claude claude-sonnet-5 "Explain this repo" --access accept-edits
npx cli-funnel login codex
npx cli-funnel update claude
```

## Use it from any language

```bash
npx cli-funnel serve --cwd /path/to/project
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:4747/v1", api_key="unused")
client.chat.completions.create(
    model="claude/claude-sonnet-5",
    messages=[{"role": "user", "content": "Explain src/main.py"}],
)
```

## Put it in a UI

```tsx
import { createClient } from "cli-funnel/client";
import { FunnelPicker, FunnelLogin, useProviders } from "cli-funnel-react";
import "cli-funnel-react/styles.css";

const client = createClient({ baseUrl: "/api/funnel" });

<FunnelPicker client={client} locked={{ access: "supervised" }} onChange={setSelection} />
```

`locked` hides a control and fixes its value, so the same component covers "let users choose" and "hardcode it". See [UI components](docs/ui.md).

## Documentation

- [Quickstart](docs/quickstart.md)
- [Concepts](docs/concepts.md)
- [Selection](docs/selection.md) and [Access levels](docs/access-levels.md)
- [Run options](docs/run-options.md): system prompt, images, JSON answers, output limit
- [Sign-in and updates](docs/auth-and-updates.md)
- [UI components](docs/ui.md)
- [OpenAI compatibility](docs/openai-compat.md) and [API keys](docs/api-keys.md)
- Providers: [Claude Code](docs/providers/claude.md), [Codex](docs/providers/codex.md), [Cursor Agent](docs/providers/agent.md), [Antigravity](docs/providers/antigravity.md)
- [Adding a provider](docs/adding-a-provider.md)
- [Keeping up with CLI changes](docs/maintenance.md)
- [Terms and limits](docs/tos-notes.md)
- [Integrating with an AI assistant](docs/ai-integration.md), plus `llms.txt` and `AGENTS.md`

## Known limits

Runs inherit the user's own CLI setup. Claude Code loads the user's CLAUDE.md, hooks and skills, so a one-line prompt can cost about 20k input tokens. Access `none` skips all of that on Claude Code and cuts most of it on Codex. Cursor Agent follows the user's Cursor approval settings, and cli-funnel always passes an explicit approval flag so those settings cannot silently widen access.

Fast mode on Claude Code is off because the CLI does not enable it headlessly. The fable model needs usage credits on a Pro plan.

Sign-in, sign-out and update are written from each CLI's own help output and covered by unit tests. They have not been run against a signed-out account yet, so treat the first real login on each CLI as a test.

Provider terms decide what you may build on a subscription. Read [Terms and limits](docs/tos-notes.md) before you ship a product.

## How it stays current

Each CLI lives in one folder. Parsers are pure functions tested against recorded real output. A nightly job installs the newest CLIs and checks that every flag we use still exists, and opens an issue if one is gone. The steps for a new model or a changed flag are in [Keeping up with CLI changes](docs/maintenance.md).

## License

MIT
