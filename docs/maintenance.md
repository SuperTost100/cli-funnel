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

`.github/workflows/nightly-drift.yml` installs the newest release of each CLI and checks that every flag cli-funnel uses still appears in that CLI's `--help`. It opens an issue when one disappears. It cannot sign in, so it cannot run the live tests. Run those locally before a release.

## Version warnings

`funnel.overview()` and `cli-funnel doctor` report `withinTestedRange`. A CLI newer than the range still runs. The warning tells you to run the live tests.

## Model ids

Model ids are never aliases. When a vendor releases a model:

1. Run `cli-funnel models <provider>` if the CLI lists models, or try the id directly with `allowUnlistedModels`.
2. Add the entry to the provider's JSON file.
3. Run the live test for that provider.

To push a model list to users without an npm release, host the merged manifest and set `manifestUrl`.
