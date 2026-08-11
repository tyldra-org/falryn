# Falryn agent guidance

Falryn is a Bun and TypeScript terminal product built from scratch. Keep its
source and tests small, explicit, and user-focused.

## Required guidance and skills

- Read the applicable global `CLAUDE.md` first, then read and apply this
  repository-level guidance before acting. Both instruction layers are required.
- Load and follow the global `typescript-best-practices` skill before creating,
  editing, updating, moving, deleting, reviewing, debugging, or configuring any
  TypeScript, TSX, JavaScript, type declaration, TypeScript test, build script,
  or `tsconfig` behavior. This requirement applies to new features, bug fixes,
  refactors, small edits, generated source, tests, configuration, and review
  work. Select and read the skill's relevant module, then apply its guidance for
  strict typing, contracts, module boundaries, dependency direction, async and
  error handling, tests, compiler configuration, and maintainability.
- Load and follow the global `opentui` skill before creating, editing, updating,
  moving, deleting, reviewing, debugging, testing, configuring, or packaging
  any OpenTUI-related code or behavior. This includes React TUI components,
  presentation adapters, renderer lifecycle, screen modes, layout, styling,
  input, focus, keymaps, animation, terminal compatibility, frame and
  interaction tests, native assets, and Bun standalone packaging. Inspect the
  installed OpenTUI version and read the skill-routed current upstream
  documentation for every affected API; use documented components, explicit
  renderer cleanup, and focused tests.
- Before creating, retaining, or refactoring terminal UI behavior, inventory
  the installed OpenTUI API and its current upstream documentation for the
  complete affected capability. Prefer documented components and renderables,
  actions and default bindings, layout, focus, selection, scrolling, keyboard,
  paste, mouse, styling, animation, renderer lifecycle, screen modes, terminal
  capability handling, and test utilities over Falryn-owned reimplementations.
  Retain custom UI code only for Falryn-specific product policy, domain state,
  or an integration seam OpenTUI cannot provide; record that ownership boundary
  in code-adjacent documentation or tests and cover it with focused validation.
- During implementation and review, map every custom TUI behavior to either
  the OpenTUI built-in it uses or a documented reason it must remain
  Falryn-owned. Do not duplicate framework behavior merely to control it.
- When a task touches OpenTUI TypeScript or TSX, both skills are mandatory:
  apply the relevant `typescript-best-practices` module and OpenTUI upstream
  guidance before changing code.
- Load and follow the global `github-workflow` skill before any Git or GitHub
  work, including status inspection, branches, commits, pushes, pull requests,
  reviews, issues, milestones, Projects, merges, releases, rulesets, or
  multi-repository delivery. Apply its safety and verification rules together
  with Falryn's repository workflow.
- Load and follow the global `falryn-delivery-loop` skill before responding to
  `Deliver — Target: ...`, `Next — Target: Falryn Roadmap`, or “what should I
  implement next?”. It coordinates one Falryn issue through the canonical
  delivery contract and gives a read-only resume/next-target report; it does not
  replace the required technical or GitHub workflow skills.
- Skill guidance supports implementation quality but does not override Falryn's
  architecture, a Ready issue's scope, or repository-owned validation.

- Use TypeScript and TSX for product code; do not introduce Rust, Cargo, or an
  internal IPC engine.
- Use Bun for package management, scripts, tests, bundling, and compiled
  executables. Use Biome for formatting and linting and `tsc --noEmit` for
  type-checking. Do not add esbuild unless a documented Bun limitation requires
  it.
- Keep the interactive application in one normal Bun process. Put intentional
  external commands behind a narrow tool-runner boundary.
- Use yargs for command routing and React with OpenTUI for the terminal UI.
- Keep persistence local and simple with `bun:sqlite` plus versioned SQL
  migrations.
- Build the complete planned capability set in TypeScript: the unified agent runtime,
  provider and tool-call lifecycle, workspace/file/search/Git/LSP tools,
  context, compression, Brief, Hush, Loom, Memory, artifacts, and computer
  use. Do not silently reduce a capability because earlier experiments used
  Rust.
- Keep provider and UI code behind one explicit tool path: validate and record
  an invocation, adapt it to a domain tool, execute it through a narrow
  boundary, then return typed output and artifacts. Do not let those layers
  access files or external tools directly.
- Any external project consulted during design is a research reference only.
  Agents may inspect its source, tests, fixtures, and history to understand
  call flow, algorithms, invariants, failures, performance choices, and edge
  cases. Translate useful findings into language-independent Falryn contracts
  and implement them for TypeScript/Bun. A consulted repository never defines
  Falryn truth and never becomes a dependency; exact source or text reuse
  requires explicit provenance, license, attribution, changed-assumption,
  destination, and test review. Record Falryn decisions in focused GitHub
  issues and protect adopted behavior with Falryn-owned tests or fixtures.
- Treat the companion `falryn-docs` repository as the home for user and
  developer documentation. Keep this repository's Markdown code-adjacent.
- Work from a Ready GitHub issue when the change is meaningful. Do not create
  phase, gate, evidence, or duplicate status-inventory documents.
- Follow the canonical delivery workflow in
  [`falryn-docs/DEVELOPMENT.md`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md):
  one PR-sized standalone issue or native implementation subissue maps to one
  short-lived implementation branch and one delivery PR containing `Closes
  #<issue>`, plus a companion docs PR only when canonical documentation
  changes. Plan keeps work **Todo**; Implement assigns the issue and sets **In
  Progress**, and sets its parent **In Progress** when the first required child
  begins; after an approved merge, re-read GitHub and verify that the intended
  issue closed and its Project status is **Done**. Keep any parent open and
  **In Progress** until all required children and integrated acceptance
  criteria pass, then close the parent and verify **Done**. Do not mix unrelated
  issues in one branch or pull request.
- Resolve correction work from the pull request's actual state. Continue a
  valid open PR on its existing branch and require a fresh Verify after every
  push. Reopen a closed-unmerged PR only when its branch, base, issue scope, and
  companion set remain valid. A merged PR cannot be reopened or merged again:
  reopen the owning issue when its original acceptance is incomplete, or
  create a focused follow-up issue for a new outcome, then branch from the
  updated default branch and open a new PR. Never reuse a squash-merged branch
  for post-merge correction. Parent integration gaps use a dedicated child
  issue and PR, not a parent branch.
- Name branches with a concise repository type prefix such as `feat/`, `fix/`,
  `docs/`, `refactor/`, `test/`, or `chore/`, followed by the issue number and
  purpose when applicable. Do not require or add an agent-name prefix such as
  `codex/`.
- Resolve ordinary repository-free prompts to this `falryn` repository:
  `Issue`, `Parent issue`, `PR`, and milestone targets all name Falryn objects.
  A Falryn PR is the delivery PR and automatically includes its explicitly
  linked `falryn-docs` companions. Use `Docs issue` and `Docs PR` only for
  docs-only work. Never substitute a same-numbered object from the other
  repository.
- In the manual Plan/Implement/Verify workflow, after a fresh Verify previews
  the complete delivery bundle, docs-first merge order, exact final subjects
  and optional issue-reference footers, and safe post-merge checkout
  synchronization, an explicit Merge prompt authorizes the unchanged preview.
  A `Deliver — Target: ...` prompt instead authorizes the resolved delivery
  bundle's automatic merge after that same fresh passing Verify; it never
  authorizes unrelated or changed pull requests. Use squash merge for ordinary
  short-lived PRs when
  enabled, with the reviewed PR title as the subject and no body by default.
  Add at most one short `Closes #N` or repository-qualified `Refs owner/repo#N`
  footer only when it adds useful durable traceability. Keep validation, risks,
  documentation impact, companion links, delivery details, and incremental
  commit messages in the PR rather than the squash commit. Merge required docs
  companions first and the Falryn delivery PR last; stop if state changed or
  any sequential merge fails.
- After every required PR in the delivery bundle has merged successfully,
  return each available clean local checkout to its repository's exact default
  branch and fast-forward it to the fetched remote default. Before switching,
  verify that the checkout is attached, clean, outside any Git operation, and
  that its local default branch can fast-forward. Re-read the final branch,
  local/default SHA, and cleanliness. Leave a dirty, detached, conflicted,
  divergent, unavailable, or otherwise unsafe checkout untouched and report
  why. Merge authorizes this safe synchronization; it never authorizes stash,
  reset, rebase, force push, conflict resolution, or local/remote branch
  deletion.
- Treat `Plan — Target: ...`, `Implement — Target: ...`, `Verify — Target:
  ...`, `Deliver — Target: ...`, and `Next — Target: Falryn Roadmap` as
  mandatory mode selectors. Before acting, read the
  canonical contracts in
  [`falryn-docs/DEVELOPMENT.md`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md#recognized-prompt-forms),
  resolve the exact GitHub target, and obey the selected mode's scope, allowed
  mutations, stop conditions, status transitions, validation, and final report.
  `Merge — Target: PR #N` is the separate manual delivery action after a fresh
  Verify; Deliver follows its distinct composite contract. Do not interpret
  another project's milestone or phase identifiers as Falryn targets.
- End every Plan, Implement, Verify, Deliver, Next, merge, and release-related
  report with one copy-ready `Suggested next prompt: ...` selected from current
  GitHub state.
  Follow the transition rules in
  [`falryn-docs/DEVELOPMENT.md`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md#suggesting-the-next-prompt).
  Use exact repository object numbers or milestone titles, never placeholders.
  A suggestion helps the user choose the next action; it does not authorize the
  agent to run that action.
- For Next routing, validate `CURRENT-STATE.md`'s Planning frontier and use the
  canonical manual transition only to resolve the next target and state. For
  every eligible Falryn issue or parent, emit the matching Deliver prompt;
  suggest a manual prompt only when Deliver cannot own the selected scope or
  when the user explicitly selected a manual workflow. A Project item's visual
  position, newly created bottom placement, or recent update is never a
  priority signal; use the explicit Priority field, dependency graph, and
  stable issue order only when no valid frontier or continuation exists.
- When a report names a repository file the user may need to open, provide both
  its clickable absolute path in the current local checkout and its
  repository-qualified path with a canonical GitHub link when one exists.
  Resolve the physical path at report time; never commit a user-specific
  absolute path or copy one into an issue or pull request. Follow
  [`falryn-docs/DEVELOPMENT.md`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md#reporting-file-locations).
- Before planning, implementing, or reviewing behavior, use
  `falryn-docs/DOCUMENTATION-MAP.md` and the issue's canonical-design links to
  locate and read the exact documentation owners. Prefer the local
  `falryn-docs` checkout when available, record each owner's impact as
  `create`, `update`, `verify-unaffected`, or `not-applicable`, and stop when a
  required contract is missing or conflicts with the issue. Do not invent
  behavior outside the selected issue and canonical contracts, silently
  diverge from them, or create duplicate documentation owners. Resolve contract
  changes in a linked documentation pull request and cross-link both pull
  requests as one delivery unit.
- Read `CURRENT-STATE.md` before making implementation or availability claims.
  It is the sole concise implementation-status owner. Update it only with
  behavior supported by current source and validation; do not copy roadmap
  checklists or design contracts into it.
- Use the [Falryn Roadmap](https://github.com/users/yogeshprasad098/projects/2)
  for live planning state and `falryn-docs/DOCUMENTATION-MAP.md` for canonical
  design ownership. An issue, Project field, or design target does not establish
  implementation truth.
- Run `bun run check` for the normal repository checks. Run `bun run build`
  when packaging changes. Add validation with the behavior it protects and
  report any check that could not run.
