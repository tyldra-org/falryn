# Workflows

Two workflows, because they answer two different questions.

| Workflow | Question | Trigger |
| --- | --- | --- |
| [`ci.yml`](ci.yml) | Is this revision safe to merge? | every pull request, and every push to `main` |
| [`benchmark.yml`](benchmark.yml) | Did this change make Falryn slower? | manual dispatch only |

## Why the benchmark is a separate file

It was one workflow once, and the manual benchmark shared `ci.yml`'s
concurrency group. Dispatching a benchmark therefore cancelled a `main`
validation that was still running, because that group sets
`cancel-in-progress: true`.

Separate files give each its own group — `CI-<ref>` and `Benchmark-<ref>` — so
an expensive optional measurement cannot cancel a required gate. The rule
generalizes: a different trigger and a different cost want different
cancellation semantics, so they want different files.

## Why the smoke jobs are not a separate file

The three compiled smokes are required pull-request gates that declare
`needs: [typecheck, dependency-integrity]`. GitHub cannot express `needs:`
across workflow files, so splitting them would either drop that ordering —
paying for a macOS runner to build a revision that does not typecheck — or
require `workflow_call` plumbing for no gain.

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
| `linux-compiled-smoke` | `ubuntu-latest` | the compiled CLI runs on Linux x64 |
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
run — the compiled binary reported itself as a `source build`, because the
embedded-module root is `/$bunfs/` on Unix but a percent-encoded `B:/%7EBUN/` on
Windows. A smoke that resolved the wrong filename would have reported *skipped*
and stayed green over it.

## `benchmark.yml`

Manual dispatch only, with a required `benchmark_base_ref` input that defaults
to `main`. The dispatched ref is the candidate; the input selects the base.

It resolves the base to a SHA and refuses an equal base/candidate pair before
measuring anything, takes eight temporally symmetric reports, and compares p50
and p95. There is no retry, no threshold bypass, and no manual allow-to-pass:
a comparison that cannot be made fails inconclusively rather than passing.

It is not scheduled for pull requests or `main` pushes, because a hosted runner
cannot produce a trustworthy performance comparison on every push, and paying a
macOS runner to produce an untrustworthy number is worse than not having one.

## `.github/actions/setup-bun`

Every job needs the same Bun runtime and the same frozen dependency set. The
composite action owns those steps so they cannot drift apart — a job that
resolved a different Bun version would produce a result the other jobs cannot be
compared against — and so the action pin, dependency caching, and any
per-platform install flag have exactly one place to change.

Its `working-directory` input exists for the benchmark's base revision, which
must select its own Bun version from its own manifest rather than inherit the
candidate's.
