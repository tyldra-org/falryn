# sync

Stay current with upstream without polluting history or losing work.

## Always fetch first

```bash
git fetch --prune <remote>
```

`git fetch` does not update the current branch or working tree, but it does update remote-tracking refs, `FETCH_HEAD`, and may run configured maintenance. Run it before every push, branch-from-remote, merge decision, or staleness check after confirming the remote.

**Never `git pull` blind.** Bare `git pull` resolves to whatever `pull.rebase` happens to be set to in this repo; merge on one machine, rebase on another. Fetch, look, then decide.

## Choosing merge vs rebase

| Situation | Do |
|---|---|
| Your branch, unpushed | After explicit rewrite confirmation, `git rebase <remote>/<default>` |
| Your branch, pushed, nobody else on it | After rewrite confirmation, `git rebase <remote>/<default>`; separately confirm the exact force-push lease |
| Shared branch, others have commits | `git merge <remote>/<default>`; never rebase shared history |
| Long-lived integration branch | `git merge`; the merge commits are the record |
| Just want the latest default branch locally | fetch, inspect, then fast-forward explicitly |

`--ff-only` on the default branch is the safety net: if it refuses, your local default has commits that aren't upstream, which means something went wrong and you want to know before it becomes a merge commit.

## Synchronize the default checkout after merge

First inspect, without changing state:

```bash
git status --short --branch
git rev-parse --abbrev-ref HEAD
git worktree list
```

Continue only when the checkout is clean, attached, and not in the middle of a merge, rebase, cherry-pick, revert, or bisect. Resolve the actual remote default branch, fetch it, then verify the local default can fast-forward:

```bash
git fetch --prune <remote>
git merge-base --is-ancestor <local-default> <remote>/<default>
git switch <local-default>
git merge --ff-only <remote>/<default>
```

If the default branch does not exist locally, create it as a tracking branch only after confirming the remote ref. If it is divergent, dirty, detached, conflicted, or checked out in another worktree, stop and report it. Do not stash, reset, rebase, force, discard changes, or resolve conflicts merely to switch branches after a merge.

Verify the final branch, upstream, SHA, and cleanliness. Branch deletion is a separate destructive action. For several repositories after GitHub landing, follow [delivery-checkout.md](delivery-checkout.md) and **gh-cli** → [issue-lifecycle.md](../../gh-cli/process/issue-lifecycle.md).

## Rebasing a feature branch

```bash
git fetch <remote>
git branch backup/<branch>-<timestamp>         # record the exact ref name
git rebase <remote>/<default-branch>
```

Rebasing rewrites SHAs. Confirm the exact outcome even when the branch is unpushed, then create and record the backup ref before invoking rebase.

Repository configuration is a separate mutation. Inspect existing `rebase.autostash` and `rerere.enabled` values; change them only when requested or required by repository guidance.

Record the old base before rebasing. Compare the old and new patch series afterward:

```bash
git range-diff <old-base>..backup/<branch>-<timestamp> \
  <remote>/<default-branch>..<branch>
```

Do not compare the old and new tip trees as a preservation check when the base changed; that diff includes upstream changes. Inspect every `range-diff` change or dropped commit and run the branch's validation before pushing.

## Conflicts

**Stop and ask.** Do not auto-resolve, do not pick a side, do not `--abort` without saying so.

Report:

1. Which command produced them (`merge`, `rebase`, `cherry-pick`, `stash pop`).
2. Which files: `git diff --name-only --diff-filter=U`.
3. For each, one line on what each side is doing; not the raw conflict hunks.
4. Current state: mid-rebase (`git status` says "interactive rebase in progress") or mid-merge.

Then wait. The user decides. When they do, apply their decision and:

```bash
git add <resolved-files>
git rebase --continue    # or: git merge --continue
```

Never `git checkout --ours` / `--theirs` on your own initiative; in a rebase those two are inverted relative to intuition, and the wrong pick silently discards work.

Escape hatches, both requiring a word to the user first:

```bash
git rebase --abort    # back to pre-rebase state
git merge --abort
```

## Pushing

An explicit request to push an owned branch authorizes that named non-force push. Pushing to another person's, a shared, or a protected branch requires an exact ownership and impact check.

Resolve the destination as one exact remote, not a remote group. Recent Git versions can accept a remote group for `git push`, which fans out to several destinations. Never trigger that behavior from a routine single-remote push.

Before pushing:

```bash
git fetch <remote>
git log <remote>/<branch>..<branch> --oneline # what you're about to send
git log <branch>..<remote>/<branch> --oneline # what you'd be missing; must be empty
```

If the second is non-empty, someone pushed. Do not force. Integrate first (per the table above), then push.

```bash
git push <remote> <branch>
```

Never `git push --all`, `--mirror`, or `--tags` as part of a routine push. Each is its own explicit ask.

## Non-fast-forward rejection

```
! [rejected]  <branch> -> <branch> (non-fast-forward)
```

This means the remote moved. Do not react by forcing. Fetch, inspect what arrived, integrate, and push again. If a force-push is genuinely the intended publication of an authorized rewrite to an owned unshared branch, obtain separate confirmation and follow the exact lease invariant in [SKILL.md](../SKILL.md#invariants).

## Upstream forks

```bash
git remote add upstream <url>
git fetch upstream
git merge upstream/<default-branch>     # or rebase, per the table
```

Resolve the repository's existing remote roles before changing them. A common convention names the contributor fork `origin` and the source repository `upstream`, but names alone do not establish ownership or write policy. Push only to the explicitly authorized remote.
