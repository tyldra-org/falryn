# Contributing to Falryn

The canonical issue lifecycle and the `Plan`, `Implement`, and `Verify` agent
modes are defined in
[`falryn-docs/DEVELOPMENT.md`](https://github.com/yogeshprasad098/falryn-docs/blob/main/DEVELOPMENT.md).

## Workflow

1. Use a GitHub issue for each meaningful feature, bug, refactor, or
   documentation outcome.
2. Plan the issue while its Project status remains **Todo**. An issue is
   **Ready** when its scope, non-goals, acceptance criteria, dependencies,
   validation, and documentation impact are resolved; Ready is a planning
   condition, not a separate Project status.
3. For implementation, assign one Ready, unblocked PR-sized issue, set it
   **In Progress**, and create a short-lived branch such as
   `feat/123-chat-composer`. Do not add an agent-name prefix.
4. Open one focused pull request and include `Closes #123` only when it fully
   resolves the issue. Record the checks actually run and link any companion
   documentation pull request.
5. After review and explicit approval, use a merge method enabled by the
   repository's current GitHub settings.
6. Re-read GitHub after merge. Verify the pull request is merged, its PR-sized
   issue is closed, and its Project status is **Done**. Leave a parent issue
   open until all required children and its integrated acceptance criteria
   pass; then verify and close the parent.

Use an issue checklist for small steps. Create sub-issues only when a child
item needs its own branch and pull request. Keep the hierarchy to one level.
One PR-sized standalone issue or subissue normally maps to one branch and one
pull request. If a parent needs integration code, create an explicit
integration subissue rather than a parent mega-PR.

## Agent modes

- `Plan — Target: Issue #N` refines GitHub planning and keeps the issue
  **Todo**; it does not create product code, a branch, or a pull request.
- `Implement — Target: Issue #N` accepts one Ready, unblocked PR-sized issue,
  moves it to **In Progress**, and produces its branch and closing pull request.
- `Verify — Target: ...` audits the named pull request, issue, parent, or
  milestone against GitHub state, source, checks, documentation, and
  `CURRENT-STATE.md`. Verification does not merge without a separate explicit
  instruction.

Every result ends with one exact, copy-ready `Suggested next prompt` based on
the refreshed GitHub state. The suggestion is guidance, not authorization to
perform the next action.

## Documentation

User-facing or developer-facing documentation belongs in the companion
`falryn-docs` repository. Link any related docs pull request from the product
pull request; land both before calling a user-facing change complete.

## Checks

Run `bun run check` before submitting ordinary changes. It runs Biome,
TypeScript type-checking, and the Bun test suite. Run `bun run build` as well
when changing packaging, entry points, embedded assets, or runtime dependencies.
Use `bun run format` and `bun run lint:fix` for local automatic fixes.

## Keep it simple

Do not add roadmaps, phases, gates, evidence records, or duplicate status
documents. The GitHub Project tracks work; the code and its checks show what
works.
