# Workflows

Four workflows.

| Workflow | Question | Trigger |
| --- | --- | --- |
| [`ci.yml`](ci.yml) | Is this revision safe to merge? | every pull request, and every push to `main` |
| [`pr-checks.yml`](pr-checks.yml) | Does the PR meet contribution requirements, and which area, size, and author-trust labels apply? | PR updates, `/recheck-vouch`, and trust-list or workflow changes |
| [`issue-governance.yml`](issue-governance.yml) | Is the public issue contract complete and are declared labels reconciled? | issue metadata or state changes |
| [`dependency-pins.yml`](dependency-pins.yml) | Do the reviewed dependency pins match this Dependabot update? | Dependabot `bun` pull requests |

`Validate contribution metadata` remains the required `main` check in
`pr-checks.yml`. It loads the policy from the
trusted base revision, validates meaningful template content, and verifies the
owning issue is an open, unblocked, metadata-complete PR-sized leaf with a
fully checked Contribution checklist or maintainer Ready checklist. The
maintainer-applied `roadmap` label selects that issue format, not private Project
membership or readiness. Maintainer issues retain the auditor's Outcome and
completion-proof heading vocabulary; public submissions retain the public form.
The area, size, and vouch label jobs receive
write-scoped tokens only to mutate labels and never check out or execute an
untrusted pull-request head. The vouch jobs use the committed
[VOUCHED.td](../VOUCHED.td) trust list, classify authors, and never grant
merge permission. `issue-governance.yml` maps an issue form's declared work
type and primary area to canonical labels, then comments on missing evidence for
the selected format. It reads current issue state, leaves an unchanged reminder
alone, and removes its reminder when the issue passes. It never asks for an
assignee or private planning field. Release milestones are public planning
metadata, so milestone changes do not trigger it.

Metadata validation runs only on `pull_request` with read-only permissions.
Area and size labeling run on `pull_request_target` for opened, reopened, and
synchronize events. Vouch selection keeps its trusted PR, comment, and main-push
triggers. Separate per-PR concurrency groups prevent label runs from cancelling
metadata validation or each other. The vouch label matrix still depends only on
its target-selection job; the other jobs run independently.

The private Roadmap is a separate maintainer product-development system.
Project membership marks an issue as adopted into that plan. Only those issues
are subject to private Status, Priority, Readiness, Target release, hierarchy,
liveness, and sequencing checks from `bun run audit:issues` and
`bun run audit:roadmap`, documented in the vendored
[`audit evidence`](../../.agents/skills/falryn-roadmap/references/audits.md)
guide. The Roadmap does not auto-add every repository issue. Its existing-item
and subissue reconciliation workflows remain enabled. The API cannot expose every
workflow filter or effect, so maintainers verify those settings against the
[`Roadmap governance`](../../.agents/skills/falryn-roadmap/references/governance.md)
contract after Project maintenance. [`CONTRIBUTOR-READINESS.md`](../../CONTRIBUTOR-READINESS.md)
explains the public/private boundary.

Issue governance and PR metadata validation apply to every human account,
including the repository owner. Dependabot retains its dedicated metadata path,
and events created by `github-actions[bot]` are skipped only to make label
reconciliation repeat-safe. Both policy jobs load
`.github/scripts/contribution-policy.cjs`; focused tests keep the form parsing
and pull-request evidence rules executable.

Relative performance comparison (`bun run measure` / `bun run benchmark:compare`)
is **local-only**. It is not a CI job: shared-runner variance made an advisory
gate expensive without earning a required check, and peers in this product class
mostly skip CI perf gates.

## Why the smoke jobs are not a separate file

The three compiled smokes are required pull-request gates that declare
`needs: [typecheck, dependency-integrity]`. GitHub cannot express `needs:`
across workflow files, so splitting them would either drop that ordering
(paying for a macOS runner to build a revision that does not typecheck) or
require `workflow_call` plumbing for no gain.

## Why the source suite and the compiled smoke stay separate jobs

They were merged into one job per host once, to save a second checkout and
install. The saving was about fifteen seconds of compute per platform, and it
cost more than it returned.

Running them in one job serialises two phases that were parallel, so a host
takes its suite plus its build plus its smoke rather than the longer of the
first two, measured at roughly a minute added to every run. It also collapses
the distinction the smokes exist to draw: `Platform tests (macOS) ✅` beside
`macOS arm64 compiled smoke ❌` says the source is fine and *bundling* broke,
and one merged row cannot say that.

The deciding cost was stability. `shell.compiled.test.ts` drives a real
pseudo-terminal and is timing-sensitive; running it after a full suite and a
compile on the same runner failed once on a frame that had painted the overlay
border but not its body, and passed on re-run. These are required checks with no
bypass actors, so a check that flakes is a merge nobody can unblock.

## `ci.yml`

The static gates (`format`, `lint`, `typecheck`, `dependency-integrity`,
`dependency-audit`) run side by side. They used to run in a chain so each failure
read in order, but the chain added about a minute of runner setup to every run,
and parallel jobs still report each failure under its own name. The platform
suites and compiled smokes wait only for `typecheck` and `dependency-integrity`,
so no macOS runner builds or tests a revision that does not typecheck.

| Job | Runner | What it establishes |
| --- | --- | --- |
| `format` | `ubuntu-latest` | Biome formatting |
| `lint` | `ubuntu-latest` | Biome lint and import organization |
| `typecheck` | `ubuntu-latest` | `tsc --noEmit` under the strict configuration |
| `dependency-integrity` | `ubuntu-latest` | direct-dependency admission and generated-output ownership |
| `dependency-audit` | `ubuntu-latest` | `bun audit` against installed packages |
| `platform-test-ubuntu`, `platform-test-macos` | Ubuntu, macOS | the complete source suite, in three balanced shards per host |
| `platform-test-windows` | `windows-latest` | the Windows platform baseline |
| `platform-test-*-gate` | `ubuntu-latest` | the required `Platform tests (…)` check for each sharded host |
| `ubuntu-x64-compiled-smoke` | `ubuntu-latest` | the compiled CLI runs on Linux x64 |
| `macos-arm64-compiled-smoke` | `macos-latest` | the compiled CLI **and** a real pseudo-terminal on darwin arm64 |
| `windows-x64-compiled-smoke` | `windows-latest` | the compiled CLI runs on win32 x64 |

### Sharded source suites

The full suite on one macOS runner took about eight minutes and was the slowest
part of every run. Ubuntu and macOS now split it with Bun's `--shard=i/3`.
`--timings=.github/test-timings.json` balances the shards by recorded per-file
durations instead of file count. A file missing from that record still runs in
some shard; a stale record only unbalances the shards. Refresh it with
`bun run test:timings` after adding or substantially changing slow suites, and
commit the result with that change.

Each shard runs its files serially, exactly as the unsharded job did, so a
timing-sensitive test sees the same load as before. The two gate jobs carry the
original required check names, `Platform tests (Ubuntu latest x64)` and
`Platform tests (macOS latest arm64)`. They run even when a shard is skipped or
fails, and pass only when every shard of that host passed, so branch rules need
no change.

### What each platform actually qualifies

The matrix is deliberately asymmetric, and the asymmetry is the point.

- **Ubuntu and macOS** run the complete `bun test` suite.
- **Windows** runs `bun run test:platform-baseline` — report-destination safety,
  CLI and SQLite source boundaries, bootstrap, build identity, and root
  resolution. It is not the full suite, because parts of that suite assert POSIX
  signal and permission behavior that Windows does not have. Presenting those as
  skipped Windows coverage would claim support that was never tested.
- **The pseudo-terminal suite is macOS only.** It allocates a terminal through
  libc's `openpty`, which Windows has no equivalent for. Terminal behavior on
  Linux and Windows is therefore *unqualified*, not merely unexercised.

A compiled smoke fails rather than skips when its executable is missing. That
distinction is load-bearing: the Windows job caught a real defect on its first
run. The compiled binary reported itself as a `source build`, because the
embedded-module root is `/$bunfs/` on Unix but a percent-encoded `B:/%7EBUN/` on
Windows. A smoke that resolved the wrong filename would have reported *skipped*
and stayed green over it.

## Security scanning

CodeQL runs through GitHub **default setup** for this repository (not a
workflow file under `.github/workflows/`). Required checks still list the
`Analyze (…)` jobs from that setup. Do not add a parallel `codeql.yml` unless
default setup is turned off. Two scanners on the same languages would only
duplicate queue time.

## `.github/actions/setup-bun`

Every job needs the same Bun runtime and the same frozen dependency set. The
composite action owns those steps so they cannot drift apart. A job that
resolved a different Bun version would produce a result the other jobs cannot be
compared against. The action pin, dependency caching, and any
per-platform install flag have exactly one place to change.

Bun itself is not hardcoded in the workflows: `oven-sh/setup-bun` reads
`package.json` via `bun-version-file` (`packageManager` / `engines.bun`). Bumping
those fields is what moves CI onto a new Bun; every job that uses the composite
action follows automatically.

Dependabot (`.github/dependabot.yml`) keeps GitHub Actions SHAs current weekly
and opens Bun package version-update PRs for **every** direct dependency in
`package.json` (production and development, including packages added later —
no Dependabot.yml edit required). Groups only batch those updates into fewer
PRs. Dependabot does not bump the Bun runtime pin.

## `dependency-pins.yml`

Dependabot changes `package.json` and `bun.lock` but not the reviewed version
pins in `tools/quality/repository-integrity.ts` or the schema URL in
`biome.json`, so every package update used to fail `Dependency integrity` until
a maintainer pushed the same mechanical commit. This workflow pushes it.

It runs only on `pull_request` events from `dependabot[bot]` for
`dependabot/bun/` branches of this repository. It installs no dependencies and
runs `bun run sync:dependency-pins`, which imports nothing from
`node_modules`, so no package code executes beside its write token. The script
changes only `version` fields and the Biome schema version. It refuses, without
writing, when a version is not exact, a package has no reviewed policy entry, or
a package moved between `dependencies` and `devDependencies`. A new license,
repository, or install hook still fails `Dependency integrity`, so admission
stays a human decision. The job commits only when a file changed, and its own
push has a different actor, so it cannot trigger itself.

Pushing with `GITHUB_TOKEN` starts the PR's CI in an approval-required state; a
maintainer approves the run from the PR. To skip that step, add a Dependabot
secret named `PIN_SYNC_TOKEN` (a fine-grained token limited to this repository
with contents write). It must be a Dependabot secret, because Actions secrets
are not passed to Dependabot-triggered runs.

Its optional `working-directory` input installs into a subdirectory checkout
when a job needs a second tree with its own manifest.
