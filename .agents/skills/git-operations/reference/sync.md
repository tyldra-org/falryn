# Synchronize refs and checkouts

Resolve the remote, branch and required freshness. Fetch when a decision depends
on current remote state; reuse an unchanged fetched baseline while doing local
work. A fetch updates tracking refs and may run maintenance, so inspect configuration
in an untrusted checkout.

```bash
git fetch <remote>
```

Use pruning only when stale tracking refs should be removed. Do not let an
uninspected `pull.rebase` setting choose integration behavior.

## Choosing merge vs rebase

Use repository policy and actual sharing. Fast-forward an unchanged local default.
Merge into shared history. Rebase an owned unshared branch when the authorized
outcome includes rewriting it. Inspect publication and other contributors before
rewriting; a rebase request alone does not imply force-pushing the result.

## Synchronize the default checkout after merge

Inspect status, branch, worktree occupancy and ongoing operations. This housekeeping
operation applies only to an eligible clean checkout; it does not authorize
resolving an unrelated dirty tree or divergent default branch.

Resolve the remote default and fetch it, then check ancestry before switching:

```bash
git merge-base --is-ancestor <local-default> <remote>/<default>
git switch <local-default>
git merge --ff-only <remote>/<default>
```

Create a missing local default as a tracking branch only after verifying the remote
ref. Skip dirty, divergent, detached, conflicted or occupied checkouts and report
why. Never stash, reset or discard work merely to synchronize after delivery.
Verify the final branch, upstream, SHA and cleanliness. Multi-checkout coordination
belongs to [delivery-checkout](delivery-checkout.md).

## Rebasing a feature branch

Follow [rewrite](rewrite.md) for scope and preservation. Record the old base and
backup before rebasing onto the resolved new base:

```bash
git branch backup/<branch>-<timestamp>
git rebase <remote>/<default-branch>
```

Compare patch series after a changed base:

```bash
git range-diff <old-base>..backup/<branch>-<timestamp> \
  <remote>/<default-branch>..<branch>
```

Inspect altered, missing and newly empty commits, then validate the resulting
behavior. Equal tip trees are not expected when upstream content changed.
Inspect autostash and rerere settings; do not change configuration merely to
simplify the operation.

## Conflicts

Inspect the current operation, all conflicted paths, both sides and the intended
behavior. Resolve an in-scope conflict when that intent is established, preserving
both changes where required. Validate the result and continue the recorded operation.
Ask when choosing a resolution would decide an unresolved product contract or
discard work outside the authorized scope.

Never mechanically choose ours or theirs. Their meaning depends on the operation,
and selecting a whole side may erase a valid change. Skipping a commit changes the
requested patch set. Abort only when returning to the recorded starting state fits
the requested outcome and preserves work added since the operation began.

```bash
git diff --name-only --diff-filter=U
git add -- <resolved-paths>
git rebase --continue
```

Use the actual operation's continuation command. Report unresolved conflicts and
leave independent work possible; do not run a destructive cleanup to leave Git idle.

## Pushing

Resolve one destination remote and exact ref. Inspect the commits to publish and
the remote state before pushing. Local-only commits are part of publication scope.
For an existing tracking branch, compare both directions; handle a missing remote
branch as first publication instead of treating the missing comparison as empty.

```bash
git log <remote>/<branch>..<branch> --oneline
git log <branch>..<remote>/<branch> --oneline
git push <remote> <branch>
```

These comparisons describe the fetched generation. A rejected push means the
remote changed or policy refused it. Inspect that result, fetch relevant state,
integrate authorized changes and validate before retrying. Do not convert a normal
push into a force-push to make it pass. [Rewrite](rewrite.md#publishing-a-rewrite)
owns leased publication of authorized rewritten history.

Use explicit remotes for forks; an alias does not prove ownership. Broad flags
such as `--all`, `--mirror` and `--tags` require scope covering every affected ref.
