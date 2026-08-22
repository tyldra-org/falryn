# Falryn agent guidance

Falryn is a Bun + TypeScript terminal product. Keep source and tests small,
explicit, and user-focused.

## Who this file is for

This configures an agent working in this repository on the maintainer's behalf.
It is not a house style for forks or for humans contributing without an agent.
If you are not that agent, ignore this file. Changes are judged on substance,
not on how they were produced.

Delivery modes are optional for everyone else. Prompts like
`Plan — Target: …`, `Implement — Target: …`, `Verify — Target: …`,
`Merge — Target: …`, `Deliver — Target: …`, and `Next — Target: Falryn Roadmap`
are the maintainer's agent workflow. Contributors are not required to use them.
Anyone who wants that workflow may follow
[`falryn-docs/DEVELOPMENT.md`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md)
and the vendored skills. Ordinary PRs that never use those prompts remain welcome.

For an agent that the maintainer has pointed at this file, the stack, skill
gates, OpenTUI ownership, and validation rules below are mandatory. Mode
contracts apply only when that agent is given one of those mode prompts.

## Before acting

1. Read any applicable personal/global agent guidance, then this file.
2. Load skills from [`.agents/skills/`](.agents/skills/README.md) as gated below.
   **Prefer the vendored copy in this repo** — it is what every checkout gets,
   including contributors without `~/.agents/skills`. Universal skills here stay
   project-agnostic; Falryn-specific maintainer workflow lives in
   `falryn-loop` only.
3. This repo is GitHub-only: `tyldra-org/falryn`. `git remote origin` is
   github.com. Companion docs: `tyldra-org/falryn-docs`.
4. Skill guidance never overrides Falryn architecture, a Ready issue's scope, or
   repository-owned validation.

## Stack (non-negotiable)

- TypeScript/TSX for product code. Do not introduce Rust, Cargo, or an internal IPC engine.
- Bun for package management, scripts, tests, bundling, and compiled executables.
  Biome for format/lint; `tsc --noEmit` for types. Do not add esbuild unless a
  documented Bun limitation requires it.
- One normal Bun process for the interactive app. External commands go behind a
  narrow tool-runner boundary.
- yargs for command routing; React + OpenTUI for the terminal UI.
- Persistence: `bun:sqlite` + versioned SQL migrations.
- Build the planned capability set in TypeScript (agent runtime, providers,
  tools, context, Brief/Hush/Loom/Memory, artifacts, computer use). Do not
  silently drop capabilities because older experiments used Rust.
- Provider and UI code share one explicit tool path: validate/record → adapt →
  execute through a narrow boundary → typed output/artifacts. Those layers must
  not touch files or external tools directly.
- External projects are research references only. Translate findings into
  Falryn contracts; never treat a consulted repo as truth or a dependency.
  Exact reuse needs provenance, license, attribution, and test review.
- User/developer docs live in companion `falryn-docs`. Keep this repo's Markdown
  code-adjacent.

## Required skills

Load from `.agents/skills/` (see the README there for the full table).

**Vendored skills (every checkout):** universal (`git-workflow`, `gh-cli`), stack
(`typescript-best-practices`, `opentui`), and project loop (`falryn-loop`). Repo
copy wins over personal `~/.agents/skills/`. Details: [`.agents/skills/README.md`](.agents/skills/README.md).

Skill split: `git-workflow` is `git` porcelain and safety. `gh-cli` is GitHub `gh`
(syntax and process).

| When | Skill |
| --- | --- |
| Creating/editing/reviewing/debugging/configuring TS, TSX, JS, tests, build scripts, or `tsconfig` | `typescript-best-practices`. Pick one primary module from its router |
| Creating/editing/reviewing/testing/packaging OpenTUI or TUI behavior | `opentui`. Prefer the pinned installed OpenTUI APIs and matching vendored docs; consult upstream only for a mismatch or planned upgrade |
| OpenTUI TypeScript/TSX | Both `typescript-best-practices` and `opentui` |
| Any mutating git work (branch, commit, rebase, push, recover) | `git-workflow` |
| GitHub issues, PRs, Actions, Projects, merge, `gh` flags | `gh-cli` |
| `Plan`, `Implement`, `Verify`, `Merge`, `Deliver`, or `Next` maintainer prompts (including "what should I implement next?") | `falryn-loop`. Maintainer modes only. Does not replace technical/GitHub skills. Not required of other contributors |

### OpenTUI ownership

Inventory the pinned installed OpenTUI version and matching vendored docs for
every affected capability before inventing UI. Consult upstream only to
investigate a mismatch or planned upgrade. Prefer documented components,
actions/bindings, layout, focus, selection, scrolling, keyboard/paste/mouse,
styling, animation, renderer lifecycle, screen modes, terminal capability
handling, and test utilities. Keep Falryn-owned UI only for product policy,
domain state, or a seam OpenTUI cannot provide, and record that boundary in
code-adjacent docs or tests. Map every custom TUI behavior to a built-in or a
documented exception. Do not duplicate framework behavior merely to control it.

## Delivery and planning (maintainer workflow; optional for others)

Canonical contract for the optional mode prompts (Plan / Implement / Verify /
Deliver / Merge / Next), merge order, correction rules, next-prompt suggestions,
and file-location reporting:

[`falryn-docs/DEVELOPMENT.md`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md)

Only when the user issues one of those mode prompts: read the linked
sections first, then obey that mode's scope, mutations, stop conditions, status
transitions, validation, and final report. Do not invent a parallel contract.
Do not force this workflow onto a contributor who is not using those prompts.

Falryn-specific reminders (for agents in this workflow):

- Meaningful work starts from a Ready GitHub issue. No phase/gate/evidence or
  duplicate status-inventory docs.
- One PR-sized standalone issue or native child → one short-lived branch → one
  Falryn delivery PR with `Closes #<issue>`, plus a docs companion PR only when
  canonical docs change. Docs-first merge; Falryn PR last.
- Branch names: `feat|fix|docs|refactor|test|chore/<issue>-purpose`. No
  agent-name prefix (`codex/`, etc.).
- Ordinary prompts resolve to this `falryn` repo. Use `Docs issue` / `Docs PR`
  for docs-only work. Never substitute same-numbered objects across repos.
- End Plan/Implement/Verify/Deliver/Next/merge/release reports with one
  copy-ready `Suggested next prompt: ...` from current GitHub state (exact
  numbers/titles; never placeholders). A suggestion does not authorize action.
  **Exception:** an in-flight `Deliver — Target: Parent chain #N` with
  remaining siblings must not end with a resume prompt — continue the next
  child in the same run (`falryn-loop` wins).
- Live planning: [Falryn Roadmap](https://github.com/orgs/tyldra-org/projects/1).
  Design ownership: `falryn-docs/DOCUMENTATION-MAP.md`. Implementation truth:
  `CURRENT-STATE.md` (update only from current source + validation).
- Before planning/implementing/reviewing, read the issue's canonical-design
  links via `DOCUMENTATION-MAP.md`. Record doc impact as `create` / `update` /
  `verify-unaffected` / `not-applicable`. Stop on missing or conflicting
  contracts.
- Maintainer Parent chain Deliver: load **`falryn-loop`** (vendored). In
  Codex, enter Goal mode with `/goal`, then send
  `Deliver — Target: Parent chain #N` as the goal prompt; do not present that
  pair as one inline command. In another harness, use its actual `/loop`
  mode-entry syntax and provide the Parent-chain target only as that harness
  supports it. Never use a per-child handoff prompt.

## Validation

- Normal checks: `bun run check`
- Packaging changes: also `bun run build`
- Add validation with the behavior it protects; report any check that could not run
