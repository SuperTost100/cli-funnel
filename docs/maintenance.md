# Keeping up with CLI changes

These CLIs ship weekly. cli-funnel is built so a change touches one folder and one JSON file.

## Where things live

| Change | Edit |
|---|---|
| New or retired model | `packages/cli-funnel/data/models/<provider>.json` |
| Renamed or new flag | `src/providers/<provider>/` |
| New output event shape | `src/providers/<provider>/parser.ts` and a fixture |
| Tested version range | The `testedRange` in the provider's `detect()` |

Nothing outside a provider folder knows a flag name.

## Fixtures

Each parser is tested offline against real output recorded from the CLI, with account details scrubbed. When a CLI changes its output, record a new fixture, watch the test fail, then fix the parser.

Live tests run against the installed CLIs and spend a few tokens. They only run when `CLI_FUNNEL_LIVE=1`:

```bash
CLI_FUNNEL_LIVE=1 npm test
```

## Checking for drift

`.github/workflows/nightly-drift.yml` installs the newest Claude Code, Codex and Cursor Agent and runs `scripts/check-drift.mjs`. The script looks for a fixed list of flags and subcommands in each CLI's help output and skips a CLI that is not installed. It opens an issue when one disappears.

The job does not cover everything:

- Antigravity is not installed in the job, so its flags are checked only when you run the script on a machine that has `agy`.
- Only the flags listed in `scripts/check-drift.mjs` are checked. When a provider starts passing a new flag, add it to that list.
- It cannot sign in, so it cannot run the live tests. Run those locally before a release.

Run the same check locally against the CLIs you have installed:

```bash
node scripts/check-drift.mjs
```

## Version warnings

`funnel.overview()` and `cli-funnel doctor` report `withinTestedRange`. A CLI newer than the range still runs. The warning tells you to run the live tests.

## Model ids

Model ids are never aliases. When a vendor releases a model:

1. Run `cli-funnel models <provider>` if the CLI lists models, or try the id directly with `allowUnlistedModels`.
2. Add the entry to the provider's JSON file.
3. Run the live test for that provider.

To push a model list to users without an npm release, host the merged manifest and set `manifestUrl`.
