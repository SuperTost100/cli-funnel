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

`.github/workflows/nightly-drift.yml` installs the newest Claude Code, Codex and Cursor Agent and runs `scripts/check-drift.mjs`. The script looks for every flag and subcommand cli-funnel uses in each CLI's help output. It opens an issue when one disappears, or when one of those three fails to install.

The job does not cover everything:

- Antigravity has no documented non-interactive installer, so the job skips it. Its flags are checked only when you run the script on a machine that has `agy`.
- The flags to check are listed in `scripts/drift-checks.mjs`. A test fails when a provider passes a `"--flag"` that the list does not have, so add the flag there when you add it to a provider.
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

## Releasing

Both packages carry the same version and ship together.

1. Open a pull request that sets `version` in `packages/cli-funnel/package.json` and `packages/react/package.json`, and the `cli-funnel` peer range in the React package. Run `npm install --package-lock-only` so the lock file follows.
2. Run the live tests locally (`CLI_FUNNEL_LIVE=1 npm test`). CI cannot sign in to the CLIs.
3. Merge it, then publish a GitHub release tagged `v<version>` with the release notes.

Publishing the release starts `.github/workflows/publish.yml`. It checks that both versions match the tag, runs typecheck, tests and build, and publishes `cli-funnel`, then `cli-funnel-react`. A version already on npm is skipped, so a failed run can be started again from the Actions tab.

The workflow signs in through npm trusted publishing, so no npm token is stored in the repository. Each package has a trusted publisher on npmjs.com (package, Settings, Trusted publishing) with these values:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `SuperTost100` |
| Repository | `cli-funnel` |
| Workflow filename | `publish.yml` |
| Environment | empty |

`npm publish` must be ticked as an allowed action. npm checks nothing when you save the form, so a typo only shows up when the workflow publishes.

npm packs `cli-funnel` with the root README. Its `prepack` script runs `scripts/package-readme.mjs`, which copies `README.md` and points its links and images at GitHub, pinned to the release tag. `cli-funnel-react` has its own `packages/react/README.md`.
