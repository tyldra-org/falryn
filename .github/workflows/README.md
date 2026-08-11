# Workflows

One workflow.

| Workflow | Question | Trigger |
| --- | --- | --- |
| [`ci.yml`](ci.yml) | Is this revision safe to merge, and is it slower? | every pull request, and every push to `main` |

## Why the benchmark is no longer a separate file

It was one workflow once, then two. The manual benchmark shared `ci.yml`'s
concurrency group, so dispatching a benchmark cancelled a `main` validation that
was still running, because that group sets `cancel-in-progress: true`.

Separate files fixed that by giving each its own group. Removing the manual
dispatch fixes it at the source: with no trigger of its own, the benchmark can
only start as part of a pull-request run, and sharing that run's group is
exactly what should happen — a new commit supersedes the measurement still
running for the previous one.

What kept the files apart was a trigger that no longer exists. What keeps the
benchmark honest is unchanged, and does not depend on the file it lives in: it
is **not a required status check**. Measurement on a shared runner varies, a
required gate that fails on variance gets bypassed, and a bypassed gate is worse
than an advisory one that is read.

## Why the compiled smokes are not a separate file

The compiled smokes are required pull-request gates that declare
`needs: [typecheck, dependency-integrity]`. GitHub cannot express `needs:`
across workflow files, so splitting them would either drop that ordering —
paying for a macOS runner to build a revision that does not typecheck — or
require `workflow_call` plumbing for no gain.

## Why the source suite and the compiled smoke share one job

They are the same question asked of one host: does this revision work here, in
source and as the artifact a user runs? Splitting them cost a second checkout
and a second dependency install per platform to learn something the first job
already had the workspace for.

The trade is deliberate. The two phases no longer run in parallel, so a host
takes as long as its suite plus its build plus its smoke rather than the longer
of the first two. In exchange each platform is one row on a pull request instead
of two, and a host that fails its source suite does not go on to spend a runner
compiling the same revision.

What is *not* traded away is per-host independence: `fail-fast: false` still
means one platform's failure never suppresses another's result.

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
| `platform` | all three | the source suite, the standalone build, and the compiled smoke, per host |
| `benchmark` | `ubuntu-latest` | whether this change is slower than the base it targets — advisory, pull requests only |

Each `platform` matrix entry runs three commands in order — `test`, `build`,
`smoke` — and the matrix carries all three per host, because what each platform
qualifies differs:

| Host | Source suite | Compiled smoke |
| --- | --- | --- |
| `ubuntu-latest` | full | the CLI |
| `macos-latest` | full | the CLI **and** a real pseudo-terminal |
| `windows-latest` | portability baseline | the CLI |

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
run — the compiled binary reported itself as a `source build`, because the
embedded-module root is `/$bunfs/` on Unix but a percent-encoded `B:/%7EBUN/` on
Windows. A smoke that resolved the wrong filename would have reported *skipped*
and stayed green over it.

### The `benchmark` job

Every pull request measures itself against its own base commit, so the
comparison is always this change against what it targets. A push to `main` has
no base to compare against, which is why the job carries
`if: github.event_name == 'pull_request'` — it is the only job here that needs
two revisions rather than one.

It resolves the base to a SHA and refuses an equal base/candidate pair before
measuring anything, takes eight temporally symmetric reports, and compares p50
and p95. There is no retry, no threshold bypass, and no manual allow-to-pass:
a comparison that cannot be made fails inconclusively rather than passing.

What makes the number trustworthy is the shape of the run: both revisions are
built and measured inside one job on one runner, interleaved so that each
occupies the same mean position in time. A drift that affects one side affects
the other equally.

It shares `needs: [typecheck, dependency-integrity]` with the platform matrix,
because measuring a revision that does not typecheck buys nothing. It does not
share the matrix's required status: see above.

## Why the benchmark runs on Ubuntu

The macOS concurrency limit is five jobs and does not rise with the plan, while
the Linux limit is twenty. `ci.yml` already spends two macOS jobs per run on
required checks, so measuring there competes with the gates that block merges.

Three of the four metrics are SQLite and blob work that is identical across
platforms. The fourth, `startup-to-first-draw`, needs a pseudo-terminal;
`openpty` resolves through `libutil.so.1` on Linux and the fixture's own test
passes on `ubuntu-latest`, so all four metrics are produced.

The cost is stated plainly: the Linux terminal is *not qualified* in this
repository's platform table, so `startup-to-first-draw` measured here describes
a surface Falryn makes no claim about. It remains valid for detecting a
regression between two revisions on one runner, and it is not evidence about
what a macOS user experiences.

## `.github/actions/setup-bun`

Every job needs the same Bun runtime and the same frozen dependency set. The
composite action owns those steps so they cannot drift apart — a job that
resolved a different Bun version would produce a result the other jobs cannot be
compared against — and so the action pin, dependency caching, and any
per-platform install flag have exactly one place to change.

Its `working-directory` input exists for the benchmark's base revision, which
must select its own Bun version from its own manifest rather than inherit the
candidate's.
