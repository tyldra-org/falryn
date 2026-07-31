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
   **In Progress**, set its parent **In Progress** when this is the first
   required child to begin, and create a short-lived branch such as
   `feat/123-chat-composer`. Do not add an agent-name prefix.
4. Open one focused Falryn delivery PR and include `Closes #123` only when it
   fully resolves the issue. Record the checks actually run. When canonical
   docs change, open a companion `falryn-docs` PR that references the delivery
   issue and cross-links the delivery PR.
5. Verify the complete delivery bundle. Preview the docs-first merge order,
   final squash subject and concise body for every PR, and safe post-merge
   synchronization of each available local checkout.
6. After the explicit Merge prompt confirms an unchanged preview, squash-merge
   required docs companions first and the Falryn delivery PR last.
7. Re-read GitHub after merge. Verify every required PR is merged, its
   PR-sized issue is closed, and its Project status is **Done**. Leave a parent
   issue open and **In Progress** until all required children and its integrated
   acceptance criteria pass; then verify, close, and mark the parent **Done**.
8. After the complete bundle has landed, return every available clean local
   checkout to its repository's fetched default branch with a fast-forward-only
   update. Verify the resulting branch, SHA, and clean state. Leave dirty,
   detached, conflicted, divergent, or unavailable checkouts untouched and
   report them. Deleting the merged local or remote branch remains a separate
   explicit action.

Use an issue checklist for small steps. Create sub-issues only when a child
item needs its own branch and pull request. Keep the hierarchy to one level.
One PR-sized standalone issue or subissue normally maps to one branch and one
closing application delivery PR; a companion docs branch and PR are added only
when canonical documentation changes. If a parent needs integration code,
create an explicit integration subissue rather than a parent mega-PR.

## Agent modes

Ordinary prompts do not need repository names. `Issue`, `Parent issue`, `PR`,
and milestone targets resolve to `falryn`; the delivery PR includes explicitly
linked docs companions automatically. Use `Docs issue` or `Docs PR` only for
docs-only work.

- `Plan — Target: Issue #N` refines GitHub planning and keeps the issue
  **Todo**; it does not create product code, a branch, or a pull request.
- `Implement — Target: Issue #N` accepts one Ready, unblocked PR-sized issue,
  moves it to **In Progress**, and produces its branch and closing pull request.
- `Verify — Target: ...` audits the named pull request, issue, parent, or
  milestone against GitHub state, source, checks, documentation, and
  `CURRENT-STATE.md`, and previews any post-merge local-checkout
  synchronization. Verification does not merge without a separate explicit
  instruction.
- `Merge — Target: PR #N` merges the verified delivery bundle when its preview
  is still current: companion docs PRs first and the Falryn delivery PR last,
  followed by safe fast-forward synchronization of available clean local
  checkouts to their default branches. `Merge — Target: Docs PR #N` is the
  docs-only equivalent. Neither form deletes branches implicitly.

Every result ends with one exact, copy-ready `Suggested next prompt` based on
the refreshed GitHub state. The suggestion is guidance, not authorization to
perform the next action.

When a report points to a repository file, it includes a clickable local path
when a checkout is available plus the repository-qualified path and GitHub
link. Machine-specific absolute paths belong only in the report, never in
committed documentation or GitHub planning records.

## Documentation

User-facing or developer-facing documentation belongs in the companion
`falryn-docs` repository. Before implementation, locate the affected canonical
owner through
[`falryn-docs/DOCUMENTATION-MAP.md`](https://github.com/yogeshprasad098/falryn-docs/blob/main/DOCUMENTATION-MAP.md)
and the issue's canonical links. Read the owner and classify its impact as
`create`, `update`, `verify-unaffected`, or `not-applicable`.

Do not invent behavior outside the Ready issue and canonical contracts or
create a second architecture, roadmap, or implementation-status owner. If the
implementation changes a contract, update the existing owner in a companion
documentation pull request, give both pull requests the same Falryn delivery
owner, cross-link them, and land both before calling the behavior complete. The
docs PR references the Falryn issue; the application delivery PR closes it.
When no documentation changes, name the owners checked and explain why they
remain unaffected.

When both repositories are checked out as siblings, the local documentation
root is normally `../falryn-docs`; otherwise use its actual checkout location.
Agent reports provide the resolved clickable absolute path plus the
repository-qualified path and GitHub link. Never persist a contributor-specific
absolute path in source, documentation, issues, or pull requests.

## Checks

Run `bun run check` before submitting ordinary changes. It runs Biome,
TypeScript type-checking, and the Bun test suite. Run `bun run build` as well
when changing packaging, entry points, embedded assets, or runtime dependencies.
Use `bun run format` and `bun run lint:fix` for local automatic fixes.

## Keep it simple

Do not add roadmaps, phases, gates, evidence records, or duplicate status
documents. The GitHub Project tracks work; the code and its checks show what
works.
