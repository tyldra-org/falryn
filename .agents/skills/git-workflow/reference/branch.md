# branch

Create, name, switch, and track branches. Naming rules live in [conventions.md](conventions.md#branch-names).

## Before creating

```bash
git status --short --branch
git fetch origin
```

Branch from a **current** base, not a stale local one. Branching off a week-old `main` guarantees a conflict later.

```bash
git switch -c feat/short-description origin/<default-branch>
```

`git switch` over `git checkout` — `checkout` overloads branch switching with file restoration, and the file-restoring form silently destroys uncommitted work.

## Choosing the base

- **Feature or fix** → the default branch.
- **Stacked work** (depends on an unlanded branch) → the parent branch. Say so in the PR description; the reviewer needs to know the diff includes the parent.
- **Hotfix on a released version** → the release tag or release branch, not the default branch.
- **Continuing someone's branch** → `git switch --track origin/<their-branch>`, and coordinate before pushing.

## Switching with dirty tree

Never force a switch over uncommitted work. Order of preference:

1. Commit it (if it's a real unit).
2. `git stash push -m "<what>"` and pop after switching.
3. `git worktree add ../<repo>-<branch> <branch>` — a second checkout, no stashing, no context loss. Best option when both branches stay active.

Never `git checkout -f`, `git switch --discard-changes`, or `git checkout .` to clear the way. Those delete work with no reflog entry.

## Worktrees

```bash
git worktree add ../<repo>-<branch> -b <branch> origin/<default-branch>
git worktree list
git worktree remove ../<repo>-<branch>
```

Use for: parallel review while a build runs, comparing two branches side by side, long-running agent work that shouldn't block your tree. Remove when done — stale worktrees block branch deletion and confuse `git branch` output.

## Tracking and publishing

Publishing a branch is normal work — it creates a ref on the remote but destroys nothing.

```bash
git push -u origin <branch>
```

After the first push, `git push` alone is correct. Never `git push --all` or `git push origin --mirror`.

## Keeping a branch current

See [sync.md](sync.md). Short version: `git fetch` then `git rebase origin/<default>` on unshared branches, `git merge origin/<default>` on shared ones.

## Deleting

Deleting a branch is irreversible from the remote's perspective — confirm before, local or remote.

Before deleting, confirm the work landed:

```bash
git branch --merged <default-branch>          # safe to delete
git log <default-branch>..<branch> --oneline  # empty means fully landed
```

If `git log <default>..<branch>` is non-empty, the branch has commits whose exact identities are not ancestors of the default branch. Say so and stop unless a squash or rebase merge is known.

Squash- and rebase-merged branches commonly appear unmerged even when their content landed. Verify the corresponding PR is `MERGED`, identify its resulting commit, and compare the branch-introduced content with the landed result. Do not delete from ancestry checks alone.

```bash
git branch -d <branch>              # refuses if unmerged — keep it this way
git push origin --delete <branch>   # separate ask
```

`git branch -D` (force) requires its own explicit approval and a backup ref first.

Switching a safe local checkout back to the default branch after a merge is synchronization, not deletion. Follow [sync.md](sync.md#synchronize-the-default-checkout-after-merge).

## Stale branch cleanup

```bash
git fetch --prune
git branch -vv | grep ': gone]'     # local branches whose remote is deleted
```

Report the list. Never bulk-delete — each one is a separate ask.

## Long-lived branches

`main`, `master`, `develop`, `release/*`, and any long-running integration branch are exempt from the prefix convention and from stale-branch cleanup. Detect them by merge commits into the default branch and by age in `git for-each-ref --sort=committerdate`.

Never rebase, force-push, or delete one without an explicit instruction naming that branch. In a release-train repo the topology *is* the record — flattening it destroys information no individual commit contains.
