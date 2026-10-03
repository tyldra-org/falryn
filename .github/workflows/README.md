# Workflows

| Workflow | Question | Trigger |
| --- | --- | --- |
| [`ci.yml`](ci.yml) | Is this revision safe to merge? | every pull request, and every push to `main` |
| [`pr-checks.yml`](pr-checks.yml) | Do the PR description and its owning issue meet the contribution contract? | PR updates |
| [`pr-labels.yml`](pr-labels.yml) | Which area, size and author-trust labels apply? | PR opened or updated, a `/recheck-vouch` comment, and trust-list changes |
| [`issue-governance.yml`](issue-governance.yml) | Is the public issue contract complete and are declared labels reconciled? | issue opened, edited, reopened, closed or relabeled |

Branch protection on `main` and release branches requires `All CI checks`,
`Validate contribution metadata` and the CodeQL `Analyze (actions)`,
`Analyze (javascript-typescript)` and `Analyze (python)` checks. It does not
require a branch to be up to date with its base: every push to `main` runs the
`full` tier, which is the backstop for a change that only conflicts with newer
work semantically. Adding, renaming or splitting a CI job never needs a ruleset
change.

## `ci.yml`

| Check | Runs | What it establishes |
| --- | --- | --- |
| `Choose what to test` | always | the tier, from [`tools/quality/ci-profile.ts`](../../tools/quality/ci-profile.ts) |
| `Static checks` | always | `bun run check:static` (Biome formatting, lint and imports, `tsc`, repository integrity, model catalogs) and `bun audit` |
| `Tests (Ubuntu x64, shard i/3)`, `Tests (macOS arm64, shard i/3)` | `scoped`, `full` | the source suite, one shard per job |
| `Tests (Windows x64, baseline)` | `scoped`, `full` | the Windows platform baseline |
| `Build and smoke test (…)` | `scoped`, `full` | each platform's executable builds and passes its compiled smoke suites |
| `All CI checks` | always | every check above succeeded, or was skipped because the tier is `docs`. The only CI check branch protection requires |

Every step runs a `package.json` script, so a local run of the same script is the same check.

### Tiers

| Tier | When | `test` runs |
| --- | --- | --- |
| `docs` | every changed path is documentation (`*.md` at the root, `docs/**`, `.agents/**/*.md`, `LICENSE`, `NOTICE`) | nothing; `windows` and `compiled` are skipped too |
| `scoped` | every changed path is TypeScript under `src/` (other than `src/main.ts`) or documentation, and at most 200 test files can reach it | `bun run test:changed`: the tests that import a changed file, plus the whole-tree suites at the `src/` root, which check files no import reaches |
| `full` | anything else, and every push to `main` | `bun run test` |

The rule fails open. A path nobody listed, an unreadable diff, a test count that
could not be measured, or any event other than a pull request selects `full`. The
push to `main` always runs `full` and is the backstop for a wrong verdict. Scoping
narrows tests, not platforms: four of 120 pull-request runs once failed only on
macOS or Windows, and each failure was in a test that imports the changed code or
in a compiled suite.

### Source suite

`bun run test` ([`tools/quality/test-shards.ts`](../../tools/quality/test-shards.ts))
runs the suite as `bun test --shard` processes, each running its files serially. CI
runs one shard per job (`FALRYN_TEST_SHARD=i/N`): three on Ubuntu and three on macOS.
Three macOS shards plus the macOS smoke leave room in GitHub's five concurrent macOS
jobs for a second run, so a pull request and `main` do not wait for each other.
Shard processes side by side on one
runner were tried: on macOS's three cores they took twelve minutes against under
five for the slowest separate shard, and on Ubuntu they failed timing-sensitive
tests.

Shards are balanced by each file's duration on that host, in
[`test-timings/`](../test-timings) (`linux.json`, `darwin.json`). Every test job
records its own files' durations and uploads them as a `test-timings-*` artifact;
`bun run test:timings` merges the latest successful `main` run's shards into those
files, to commit when shards drift out of balance. A serial local recording balanced
CI badly, because a file costs a different share on each host: it once gave one
Ubuntu shard 510 small files and 302 s while the others ran 68 s and 79 s. A stale
record only unbalances the shards.

A failing file is retried once, alone, only when
[`known-flaky-tests.json`](../known-flaky-tests.json) lists it with the open issue
that owns its fix, and at most three files failed. A pass then keeps the run green
with a warning naming that issue. Any other failure fails the run, including a new
intermittent one, because it may be the change under review.

### What each platform qualifies

- **Ubuntu and macOS** run the complete source suite.
- **Windows** runs `bun run test:platform-baseline`: report-destination safety, CLI
  and SQLite source boundaries, bootstrap, build identity and root resolution.
  Parts of the full suite assert POSIX signal and permission behavior that Windows
  does not have; showing them as skipped would claim support never tested.
- **The pseudo-terminal suite is macOS only.** It allocates a terminal through
  libc's `openpty`, which Windows lacks. Terminal behavior on Linux and Windows is
  unqualified, not merely unexercised.

The compiled smokes stay separate jobs from the source suite. Merged, a host takes
its suite plus its build rather than the longer of the two, the timing-sensitive
pseudo-terminal suite once failed after a full suite on the same runner, and
`Tests (macOS arm64, …)` ✅ beside `Build and smoke test (macOS arm64)` ❌ no longer says
that bundling, not the source, broke. Each smoke names its target, so a missing
executable or one reporting another platform fails instead of skipping. That
caught a Windows binary that called itself a `source build`.

Performance comparison (`bun run measure`, `bun run benchmark:compare`) is
local-only: shared-runner variance made a CI gate expensive without earning it.

## Contribution metadata and labels

`Validate contribution metadata` runs on every `pull_request` with read-only
permissions. It loads [`contribution-policy.cjs`](../scripts/contribution-policy.cjs)
from the trusted base revision and checks the PR template and its owning issue:
open, unblocked, a PR-sized leaf with a complete checklist. The maintainer `roadmap`
label selects the issue format, not Roadmap membership or readiness. A base
revision without that policy has nothing trusted to run, so the check passes with a
notice.

`pr-labels.yml` runs on `pull_request_target`, so fork pull requests receive labels,
with label-write tokens. No label job checks out or executes pull-request code: the
area job reads changed-file metadata, and the size and vouch jobs load
[`pr-labels.cjs`](../scripts/pr-labels.cjs) from the base or default branch. The
vouch labels come from [`VOUCHED.td`](../VOUCHED.td) and never grant merge
permission. A comment starts a runner only when it is `/recheck-vouch` on a pull
request.

`issue-governance.yml` maps an issue form's declared work type and primary area to
labels and comments on missing evidence, removing its comment once the issue passes.
It never asks for an assignee or a private planning field. Both policy jobs apply to
every human account, including the owner; Dependabot has its own metadata path.
Organization-only Roadmap fields are checked by `bun run audit:issues` and
`bun run audit:roadmap`, not by these workflows.

## Dependencies and security

[`.github/actions/setup-bun`](../actions/setup-bun/action.yml) installs the Bun
version `package.json` names and the frozen dependency set for every job. It
restores the download cache everywhere and saves it only from `main`.

Dependabot opens one weekly pull request for every action pin and one each for
production and development packages, proposing a release only once it is three
days old; security updates come at once. `package.json` owns every package
version, so a version update passes `bun run verify:repository` unchanged. A new
license, repository, install hook or dependency group fails it until
`tools/quality/repository-integrity.ts` admits that dependency.

CodeQL runs through GitHub default setup, not a workflow file here. Do not add a
`codeql.yml` while default setup is on.
