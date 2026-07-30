# Falryn

Falryn is a new local terminal coding agent built from scratch with Bun and
TypeScript. It is neither a RavenCode migration nor a compatibility layer:
Falryn owns its code, architecture, data, documentation, and release history.

## Track Falryn

- [Current state](CURRENT-STATE.md) — what is actually implemented and verified
  in this repository, plus the current planning frontier.
- [Falryn Roadmap](https://github.com/users/yogeshprasad098/projects/2) — live
  milestones, parent outcomes, native subissues, status, priority, and linked
  pull requests.
- [Documentation map](https://github.com/yogeshprasad098/falryn-docs/blob/main/DOCUMENTATION-MAP.md)
  — canonical product, architecture, subsystem, UI, guide, reference, and
  operations owners.
- [Falryn Docs](https://github.com/yogeshprasad098/falryn-docs) — the companion
  documentation repository.

Design pages describe the target. GitHub owns planning and workflow state.
[`CURRENT-STATE.md`](CURRENT-STATE.md), source, tests, and released artifacts
establish what exists. These roles are linked but never interchangeable.

## Direction

- TypeScript and TSX product code; no Rust workspace or Cargo toolchain.
- One Bun application process in normal interactive use.
- A compiled Bun executable for each supported operating system and CPU target.
- SQLite through Bun's built-in `bun:sqlite` module.
- A small, issue-first GitHub Flow workflow.

## Product scope

Falryn is not a reduced CLI or a TUI rewrite. Its product ambition includes the
complete capability set we explored with RavenCode: the unified agent runtime;
provider streaming and tool calling;
multi-layer tool routing and execution; workspace, file, search, Git, and LSP
services; context selection and rendering; compression; Brief, Hush, Loom,
Memory, and artifact handling; computer use; and both headless CLI and
interactive OpenTUI experiences.

Each capability is designed and built directly in TypeScript. A tool call should
pass through one explicit route—validation and lifecycle handling, a domain
adapter, the relevant executor, then recorded output and artifacts—rather than
letting providers or UI components reach files or external tools directly.

Earlier RavenCode designs and archives are research references for useful
flows, ideas, and edge cases; they are not Falryn source material or canonical
specifications. Falryn chooses its own behavior in focused GitHub issues and
protects important behavior with its own tests and fixtures.

## Repositories

- `falryn` contains the application and its tests.
- `falryn-docs` contains user and developer documentation.

The minimal Bun and TypeScript toolchain scaffold is present; product behavior
has not been implemented yet. See [Current state](CURRENT-STATE.md) for the
verified inventory and next planning action. Start meaningful work from a Ready
GitHub issue and keep each pull request focused on that issue.

## Development commands

Install the pinned dependencies with `bun install`. The repository uses:

- `bun run dev` to run the TypeScript entry point;
- `bun run format` and `bun run lint` for Biome formatting and linting;
- `bun run typecheck` for independent TypeScript checking;
- `bun test` for the Bun test suite;
- `bun run check` for the normal local quality suite;
- `bun run build` to compile `dist/falryn` as a standalone Bun executable; and
- `bun run ci` to run the quality suite and compiled build together.

Bun owns transpilation, bundling, and executable compilation. Falryn does not
carry an esbuild dependency.
