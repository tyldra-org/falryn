---
name: git-operations
description: Inspect and change Git checkouts, commits, branches, worktrees, remotes and history while preserving unrelated work. Use for Git operations; forge records belong to the matching forge skill.
---

# Git operations

Own local Git state and transport. Repository guidance chooses branch strategy,
commit conventions, hooks, signing and release policy. A forge skill owns remote
issues, reviews and PR merges. Read-only status, diff, log and blame need only the
requested inspection, not the mutation procedure.

## Resolve the operation

Identify the requested result, repository, checkout, affected paths and refs.
Read `AGENTS.md` and relevant contribution rules. Inspect status, both diffs,
remotes, worktree occupancy and any operation already in progress. Inspect the
destination instead when initializing or cloning. Do not assume a remote alias,
default branch, identity or checkout layout.

Reuse unchanged context within the task. Refresh affected refs before depending
on remote state, and re-read local state before writing. Use installed help for
exact flags and machine formats for scripting. A remembered version audit is
not evidence about this checkout.

## Authorization and preservation

The user and higher-priority repository instructions establish authority. Keep
that authority separate from evidence that an operation is safe now. A request
can authorize several necessary steps; do not ask again for each covered step.
A request limited to one revision, ref or effect stays limited to that target.

Rewrites, force-pushes, discards, deletions, tag moves and object expiry require
scope that covers their effects. Inspect the exact candidate before acting; ask
only when authority is missing or the outcome is ambiguous. One explicit cleanup
request may cover a bounded set, but every member still needs preservation checks.
A commit request or autocommit policy alone does not authorize publication.

Preserve unrelated staged, unstaged and untracked work. Continue in non-overlapping
paths or a separate worktree when that is safe. Do not stash, commit, reset or
clean someone else's changes to make progress. A backup ref preserves commits,
not uncommitted or ignored files.

## Invariants

- Stage only inspected, intended paths. Verify the staged diff before committing.
- Keep hooks, signing, protection and required validation enabled. Repair an
  in-scope hook failure and retry after validation; never bypass it.
- Before rewriting, record old refs and a recoverable backup. Validate content
  preservation according to whether the base changed.
- Force-push only an authorized owned ref with an explicit lease:
  `--force-with-lease=<branch>:<expected-old-sha>`. A changed remote requires
  inspection and reconciliation, never blindly refreshing the lease.
- Keep secrets out of commits, URLs, configuration and output. Exposed credentials
  require rotation; history removal alone does not contain the exposure.
- Inspect unknown or in-progress state before writing. Resolve conflicts from
  the intended behavior when that work is authorized; ask for an unresolved
  product choice rather than mechanically choosing ours or theirs.
- If a command's result is uncertain, read the resulting state before retrying.
  Suspected corruption or lost work routes to recovery before further mutation.

## Choose the owning reference

| Intent | Guide |
| --- | --- |
| Initialize, clone, change remotes, use sparse/partial clones, submodules, or LFS | [repository-layout.md](reference/repository-layout.md) |
| Stage or commit | [commit.md](reference/commit.md) |
| Branch create, switch, or delete | [branch.md](reference/branch.md) |
| Create, move, lock, repair, or remove a linked worktree | [worktree.md](reference/worktree.md) |
| Fetch, pull, rebase, or push | [sync.md](reference/sync.md) |
| Synchronize default checkouts after delivery | [delivery-checkout.md](reference/delivery-checkout.md) |
| Local merge | [merge.md](reference/merge.md) |
| Restore, reset, revert, clean, or manage a stash | [undo.md](reference/undo.md) |
| Cherry-pick, apply, or exchange patches | [patches.md](reference/patches.md) |
| Amend, rebase, squash, rewrite, or force-push | [rewrite.md](reference/rewrite.md) |
| Recover lost or overwritten work | [recover.md](reference/recover.md) |
| Find the introducing commit | [bisect.md](reference/bisect.md) |
| Secret/history/size audit | [audit.md](reference/audit.md) |
| Configure Git, ignore rules, attributes, hooks, credentials, or signing | [configuration.md](reference/configuration.md) |
| Diagnose repository health or run maintenance, fsck, gc, prune, or bundles | [maintenance.md](reference/maintenance.md) |
| Create or move a Git tag | [release.md](reference/release.md) |
| Subject, branch, and tag conventions | [conventions.md](reference/conventions.md) |

Load another reference only for a distinct operation. References describe checks
and mechanics; their authorization requirements use the scope rule above.
`confirm` means establish the fact or applicable authority, not automatically
request a new user response.

## Verify and report

Check the resulting status, index and affected refs. For changed bases, compare
patch series and validate behavior rather than demanding equal tip trees. Report
the result, relevant old/new SHAs, checks and any preserved or unresolved state.
For consequential ref changes, name the available recovery path. Routine commits
need a concise result, not a full repository inventory.
