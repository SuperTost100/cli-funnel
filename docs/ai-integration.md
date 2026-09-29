# Integrating with an AI assistant

If you are an AI coding assistant adding cli-funnel to a project, follow this order. Every step has a command that proves it worked.

1. Run `npx cli-funnel doctor --json`. Read `installation.installed` and `auth.loggedIn` for each provider. If the provider the user wants is missing or signed out, tell the user to install it or run `npx cli-funnel login <provider>`. Do not try to sign in for them.
2. Run `npx cli-funnel models <provider> --json`. Pick a model `id` from that output. Never invent an id and never use an alias.
3. Install: `npm install cli-funnel`. For React UI, also `npm install cli-funnel-react`.
4. Write one selection object using only values from step 2 and from `capabilities.access`. Use an absolute `cwd`.
5. Call `funnel.run({ selection, prompt })`. Print `result.text`.
6. If the user wants a UI, mount `createHandler` from `cli-funnel/server` behind a token and render `FunnelPicker`. See [UI components](ui.md).

## Facts to rely on

- `access: "supervised"` needs an `onApproval` callback and only some providers offer it. Check `capabilities.access`.
- `funnel.run()` resolves to `{ text, usage, sessionId, model, finishReason, toolCalls, deniedActions }`. Pass `sessionId` back to continue.
- A `deniedActions` entry means the CLI refused a tool call because nobody could approve it. Raise the access level or choose a provider that supports `supervised`.
- Errors from bad settings are `FunnelError` with `code` `invalid-selection`. The message lists the valid values.
- Do not run `login`, `logout` or `update` without asking the user. They change the user's real account and install.

The repository root has `llms.txt` and `AGENTS.md` with the same rules in a shorter form.
