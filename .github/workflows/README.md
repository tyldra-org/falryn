# Workflows

One workflow.

| Workflow | Question | Trigger |
| --- | --- | --- |
| [`ci.yml`](ci.yml) | Is this revision safe to merge? | every pull request, and every push to `main` |

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

Static gates run first and in order, because each one makes the next one's
failure easier to read: `format` → `lint` → `typecheck` → `dependency-integrity`.
Everything after that fans out in parallel from `typecheck` and
`dependency-integrity`.

| Job | Runner | What it establishes |
| --- | --- | --- |
| `format` | `ubuntu-latest` | Biome formatting |
| `lint` | `ubuntu-latest` | Biome lint and import organization |
| `typecheck` | `ubuntu-latest` | `tsc --noEmit` under the strict configuration |
| `dependency-integrity` | `ubuntu-latest` | direct-dependency admission and generated-output ownership |
| `dependency-audit` | `ubuntu-latest` | `bun audit` against installed packages |
| `platform-test` | all three | the source suite, per host |
| `ubuntu-x64-compiled-smoke` | `ubuntu-latest` | the compiled CLI runs on Linux x64 |
| `macos-arm64-compiled-smoke` | `macos-latest` | the compiled CLI **and** a real pseudo-terminal on darwin arm64 |
| `windows-x64-compiled-smoke` | `windows-latest` | the compiled CLI runs on win32 x64 |

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

Its optional `working-directory` input installs into a subdirectory checkout
when a job needs a second tree with its own manifest.
