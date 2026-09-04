# Developing Falryn

This repository contains everything needed to inspect, build, test, and change
Falryn from a public checkout. Product work starts from a public Falryn issue.
Private documentation and Project access may help maintainers coordinate a
delivery, but they are never prerequisites for implementing a Ready public
issue.

## Sources of truth

Use the owner for the fact you need. Do not copy the same contract into another
file.

| Question | Owner |
| --- | --- |
| What is implemented now? | Source, tests, builds, and [CURRENT-STATE.md](CURRENT-STATE.md) |
| What must this change deliver? | The named public GitHub issue and its native relationships |
| How do I build and contribute? | This file and [CONTRIBUTING.md](CONTRIBUTING.md) |
| What does a pull request need? | [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) |
| What do repository checks enforce? | `package.json`, `.github/workflows/`, and their source scripts |
| What are the long-lived product and architecture contracts? | The private Falryn Docs repository, for authenticated maintainers |
| What is the delivery order or Project state? | The private Falryn Roadmap, for authenticated maintainers |

If a public issue is marked Ready, its body must contain every baseline,
boundary, failure rule, wiring point, test expectation, and documentation-impact
fact needed for that slice. A private link may add maintainer context, but it
cannot replace the public handoff. Ask for the issue to be completed when you
would otherwise have to guess.

## Set up a checkout

Install Git and the exact Bun version declared by `packageManager` and
`engines.bun` in `package.json`, then run:

```sh
git clone https://github.com/tyldra-org/falryn.git
cd falryn
bun install --frozen-lockfile
bun run dev
```

`bun run dev` runs `src/main.ts`. With no subcommand, a capable terminal opens
the OpenTUI shell. A non-interactive terminal receives help or a named refusal
instead of an attempted interactive session.

Build and inspect the standalone executable with:

```sh
bun run build
./dist/falryn --version
```

Falryn is pre-release. There is no supported package-manager installation or
published binary yet.

## Repository map

The directory name is not enough to prove ownership. Read the neighboring
source and tests before changing a boundary.

| Path | Responsibility |
| --- | --- |
| `src/domain/` | Portable contracts, state transitions, and pure decisions |
| `src/application/` | Use cases and composition over domain contracts |
| `src/integrations/` | Host filesystem, process, Git, and other external adapters |
| `src/providers/` | Provider SDK adapters and model catalogs |
| `src/config/` and `src/data/` | Configuration, persistence, migrations, and local-data ownership |
| `src/presentation/` | Shared human-facing projections |
| `src/tui/` | OpenTUI renderables, interaction, focus, and terminal behavior |
| `src/cli/` | Command tree, process boundaries, output formats, and runtime composition |
| `tools/` | Repository checks, governance auditors, generators, and benchmarks |

Falryn runs as one Bun process. External commands and stateful host behavior
stay behind narrow typed adapters. Product behavior must reach its real CLI,
OpenTUI, headless, model, export, replay, or diagnostic composition point. An
isolated library that no product path uses is not a completed user feature.

## Choose a unit of work

Outside issues and pull requests are currently restricted. Collaborators use
the same issue-backed path that will apply when outside contributions open.

1. Select one assigned, Ready, unblocked PR-sized issue.
2. Read its native parent, subissues, blockers, linked pull requests, and public
   completion proof.
3. Verify the stated baseline against the current default branch.
4. Stop if the issue is a parent outcome, has unresolved requirements, or
   depends on private text for implementation behavior.
5. Create or continue one short-lived branch for that delivery owner.

Parents collect integrated outcomes. They do not own branches or large pull
requests. Work that needs separate review belongs in a native child issue. A
checklist is enough for steps that cannot produce a useful pull request by
themselves.

## Make the change

Keep the diff focused on the owning issue:

1. Add the smallest coherent implementation and its tests.
2. Cover successful, invalid, partial, cancelled, unavailable, restart, and
   cleanup behavior that applies to the slice.
3. Preserve explicit limits for time, bytes, counts, concurrency, retries,
   retention, and external effects.
4. Update [CURRENT-STATE.md](CURRENT-STATE.md) only when source-verified
   behavior changes.
5. Update an existing public documentation owner instead of creating a second
   page for the same subject.
6. Run focused checks while iterating, then the complete review boundary.

Do not add empty packages for future work, copy a topology from another
project, weaken a type or test to make a check pass, or hide unsupported
behavior behind documentation.

## Validation

Use the smallest command that proves the current edit while iterating.

| Command | Use |
| --- | --- |
| `bun run check:static` | Formatting, lint, types, repository integrity, and model catalogs |
| `bun run test:changed` | Tests affected relative to `main` |
| `bun test <path>` | One focused test file |
| `bun run test:watch` | Re-run tests while files change |
| `bun run test:parallel` | Bounded four-worker source suite |
| `bun run check` | Canonical static checks and full source suite |
| `bun run build` | Standalone executable compilation |

Run `bun run check` and `bun run build` before requesting review. Packaging,
entrypoint, terminal, or compiled-runtime changes also need the relevant
compiled smoke command from `package.json`. Performance claims need the matching
measurement or benchmark script and a recorded comparison. Report skipped or
unavailable checks instead of treating them as passes.

## Documentation and code delivery

Public Falryn owns this development guide, `README.md`, `CONTRIBUTING.md`,
`CURRENT-STATE.md`, security and workflow guidance, issue and pull-request
templates, fixtures, and source comments. Those files explain public checkout
behavior and verified implementation state.

Falryn Docs privately owns the detailed product, architecture, user-guide,
reference, and future-design contracts. Public contributors do not need access.
When a code change may affect those contracts, record the impact in the public
issue and pull request using the applicable result:

- `public-code-adjacent-update`: a public owner changed with the code;
- `private-update-required`: a stable private contract is likely to change;
- `private-verify-unaffected`: an authenticated maintainer checked the private
  owner at the stated revision and found no change;
- `private-verification-unavailable`: the contributor cannot inspect the
  private owner; or
- `not-applicable`: the change cannot affect documentation.

Several results may apply. `not-applicable` is exclusive. A contributor without
private access may use `private-update-required` or
`private-verification-unavailable`; a maintainer resolves that state before
merge.

For a code and private-docs delivery:

1. The public Falryn issue remains the delivery owner.
2. The application pull request closes that issue.
3. An authenticated maintainer opens or updates a private docs companion only
   when a canonical owner must change.
4. The two pull requests use reciprocal links and identify the same delivery
   owner without copying private text into Falryn.
5. The docs companion merges first. The unchanged application pull request
   merges last.

A public documentation-only change uses a Falryn issue and pull request. A
private canonical-documentation change with no application effect uses its own
Falryn Docs issue and pull request. Never infer ownership from equal issue
numbers across repositories.

## Pull requests

Use the repository template. Every non-Dependabot pull request must:

- use `Closes #N` when it fully delivers the public issue, otherwise `Refs #N`;
- describe the scope, exact checks and observed results, documentation impact,
  risk, and limitations;
- identify any companion pull request without disclosing private content;
- target the current default branch and contain no unrelated work; and
- use a conventional title suitable for the final squash commit subject.

Do not commit credentials, snapshots, contributor-specific absolute paths, or
private issue, Project, or documentation content. Keep validation and delivery
detail in the pull request rather than copying it into a subject-only squash
commit.

## Maintainer-only coordination

Ordinary contributors stop at the public issue, source, checks, and pull
request. Authenticated maintainers use
[CONTRIBUTOR-READINESS.md](CONTRIBUTOR-READINESS.md) for repository-opening and
governance controls. Agents use the vendored
`.agents/skills/falryn-workflow/` bundle for exact Plan, Implement, Review,
Verify, Merge, Deliver, Next, audit, and cross-repository rules.

Private access adds authority. It never changes the meaning of public source or
allows private state to leak into a public artifact.
