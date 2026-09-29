# cli-funnel

Use Claude Code, Codex, Cursor Agent and Antigravity CLIs like an API. The package spawns the real CLI binary, so work counts against the user's subscription.

## Commands

- `npm run typecheck` and `npm test` from the repo root
- `CLI_FUNNEL_LIVE=1 npm test` runs live tests against the installed CLIs. They spend a few tokens.
- `node scripts/check-drift.mjs` checks that the flags we use still exist

## Layout

- `packages/cli-funnel/src/types.ts` is the contract. Read it first.
- `src/providers/<id>/` holds everything that knows a CLI flag. Nothing else may.
- `data/models/<id>.json` lists model ids. Ids are concrete and versioned. Never add aliases like "latest".
- `src/server/` is the HTTP handler and the OpenAI-compatible endpoints. `src/client/` is its browser client.
- `packages/react/` has hooks and components.
- `docs/` is user documentation. Keep it plain.

## Rules

- Never run `login`, `logout` or `update` on a real CLI while testing. They change the user's account and install.
- Never pass `claude --bare`. It disables subscription login.
- Never read or store OAuth tokens. Never put emails, org ids or tokens in fixtures.
- List an access level in a provider's `capabilities.access` only if the CLI can enforce it headlessly. `supervised` needs a working approval passthrough. `none` needs a mode the CLI enforces, not one the model is asked to follow.
- Parsers are pure functions tested against recorded fixtures.
- Writing style for docs and comments: direct, no em dashes, no filler.

## Integrating cli-funnel into another project

See `docs/ai-integration.md`.
