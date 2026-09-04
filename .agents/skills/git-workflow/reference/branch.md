# branch

Create, name, switch, and track branches. Naming rules live in [conventions.md](conventions.md#branch-names).

## Before creating

```bash
git status --short --branch
git fetch <remote>
```

Branch from the repository's intended current base, not an unverified local default branch. A stale base increases conflict and rework risk.

```bash
git switch -c feat/short-description <remote>/<default-branch>
```

`git switch` over `git checkout`; `checkout` overloads branch switching with file restoration, and the file-restoring form silently destroys uncommitted work.

## Choosing the base

- **Feature or fix** → the default branch.
- **Stacked work** (depends on an unlanded branch) → the parent branch. Say so in the PR description; the reviewer needs to know the diff includes the parent.
- **Hotfix on a released version** → the release tag or release branch, not the default branch.
- **Continuing someone's branch** → `git switch --track <remote>/<their-branch>`, and coordinate before pushing.

## Switching with dirty tree

Never force a switch over uncommitted work. Order of preference:

1. Commit it (if it's a real unit).
2. `git stash push -m "<what>"` and pop after switching.
3. Create a linked worktree through [worktree.md](worktree.md) when both branches must stay active.

Never `git checkout -f`, `git switch --discard-changes`, or `git checkout .` to clear the way. Those delete work with no reflog entry.

## Worktrees

Linked worktrees share refs and the object database but have separate working trees, indexes, and `HEAD`s. Use [worktree.md](worktree.md) for creation, occupancy checks, movement, locking, repair, and removal.

## Tracking and publishing

Publishing a branch creates outward-facing remote state. An explicit request to push that branch authorizes the named non-force push; otherwise confirm the remote and branch first.

```bash
git push -u <remote> <branch>
```

After the first push, a plain `git push` is correct only when the configured upstream and `push.default` were verified. Never use `git push --all` or `git push --mirror` as a shortcut.

## Keeping a branch current

See [sync.md](sync.md). Short version: fetch, then rebase onto `<remote>/<default>` only for an authorized unshared-history rewrite, or merge that ref into a shared branch.

## Deleting

Deleting a branch removes an easy-to-find ref and can discard unpublished work. Confirm the exact local or remote ref first.

Before deleting, confirm the work landed:

```bash
git branch --merged <default-branch>          # safe to delete
git log <default-branch>..<branch> --oneline  # empty means fully landed
```

If `git log <default>..<branch>` is non-empty, the branch has commits whose exact identities are not ancestors of the default branch. Say so and stop unless a squash or rebase merge is known.

Squash- and rebase-merged branches commonly appear unmerged even when their content landed. Verify the corresponding PR is `MERGED`, identify its resulting commit, and compare the branch-introduced content with the landed result. Do not delete from ancestry checks alone.

```bash
git branch -d <branch>              # refuses if unmerged; keep it this way
git push <remote> --delete <branch> # separate ask
```

`git branch -D` (force) requires its own explicit approval and a backup ref first.

Switching a safe local checkout back to the default branch after a merge is synchronization, not deletion. Follow [sync.md](sync.md#synchronize-the-default-checkout-after-merge).

## Stale branch cleanup

```bash
git fetch --prune
git branch -vv | grep ': gone]'     # local branches whose remote is deleted
```

Report the list. Never bulk-delete; each one is a separate ask.

## Long-lived branches

`main`, `master`, `develop`, `release/*`, and any long-running integration branch are exempt from the prefix convention and from stale-branch cleanup. Identify them from repository guidance, protection, upstream configuration, and established topology. Age or merge frequency alone is not enough.

Never rebase, force-push, or delete one without an explicit instruction naming that branch. In a release-train repo the topology *is* the record; flattening it destroys information no individual commit contains.
