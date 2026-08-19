# sync

Stay current with upstream without polluting history or losing work.

## Always fetch first

```bash
git fetch --prune origin
```

`git fetch` is always safe — it never touches your working tree or your branches. Run it before every push, every branch creation, every merge decision, every "is this stale" question.

**Never `git pull` blind.** Bare `git pull` resolves to whatever `pull.rebase` happens to be set to in this repo — merge on one machine, rebase on another. Fetch, look, then decide.

## Choosing merge vs rebase

| Situation | Do |
|---|---|
| Your branch, unpushed | `git rebase origin/<default>` — linear, no noise |
| Your branch, pushed, nobody else on it | `git rebase` then force-push with lease (confirm first) |
| Shared branch, others have commits | `git merge origin/<default>` — never rebase shared history |
| Long-lived integration branch | `git merge` — the merge commits are the record |
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
git fetch --prune origin
git merge-base --is-ancestor <local-default> origin/<default>
git switch <local-default>
git merge --ff-only origin/<default>
```

If the default branch does not exist locally, create it as a tracking branch only after confirming the remote ref. If it is divergent, dirty, detached, conflicted, or checked out in another worktree, stop and report it. Do not stash, reset, rebase, force, discard changes, or resolve conflicts merely to switch branches after a merge.

Verify the final branch, upstream, SHA, and cleanliness. Branch deletion is a separate destructive action. For several repositories after GitHub landing, follow [delivery-checkout.md](delivery-checkout.md) and **gh-cli** → [issue-lifecycle.md](../../gh-cli/process/issue-lifecycle.md).

## Rebasing a feature branch

```bash
git fetch origin
git branch backup/<branch>-$(date +%Y-%m-%d)   # cheap insurance; free to delete after
git rebase origin/<default-branch>
```

Rebasing rewrites SHAs. Back up first; confirm first if the branch is published.

Enable these once per repo; they make rebase materially safer:

```bash
git config rebase.autostash true   # stash/pop around the rebase
git config rerere.enabled true     # remember conflict resolutions
```

After the rebase, verify content survived:

```bash
git diff backup/<branch> <branch>   # empty means the rebase changed no content
```

A non-empty diff after a pure rebase means a conflict resolution changed the result. Read it before pushing.

## Conflicts

**Stop and ask.** Do not auto-resolve, do not pick a side, do not `--abort` without saying so.

Report:

1. Which command produced them (`merge`, `rebase`, `cherry-pick`, `stash pop`).
2. Which files: `git diff --name-only --diff-filter=U`.
3. For each, one line on what each side is doing — not the raw conflict hunks.
4. Current state: mid-rebase (`git status` says "interactive rebase in progress") or mid-merge.

Then wait. The user decides. When they do, apply their decision and:

```bash
git add <resolved-files>
git rebase --continue    # or: git merge --continue
```

Never `git checkout --ours` / `--theirs` on your own initiative — in a rebase those two are inverted relative to intuition, and the wrong pick silently discards work.

Escape hatches, both requiring a word to the user first:

```bash
git rebase --abort    # back to pre-rebase state
git merge --abort
```

## Pushing

Pushing your own branch is routine. Pushing to a branch someone else works on is not — say what you're about to send first.

Before pushing:

```bash
git fetch origin
git log origin/<branch>..<branch> --oneline   # what you're about to send
git log <branch>..origin/<branch> --oneline   # what you'd be missing — must be empty
```

If the second is non-empty, someone pushed. Do not force. Integrate first (per the table above), then push.

```bash
git push origin <branch>
```

Never `git push --all`, `--mirror`, or `--tags` as part of a routine push. Each is its own explicit ask.

## Non-fast-forward rejection

```
! [rejected]  <branch> -> <branch> (non-fast-forward)
```

This means the remote moved. **It is never fixed by forcing.** Fetch, inspect what arrived, integrate, push again. If forcing is genuinely correct (you rewrote your own unshared branch), that's a separate explicit ask — see the force-push invariant in [SKILL.md](../SKILL.md#force-push).

## Upstream forks

```bash
git remote add upstream <url>
git fetch upstream
git merge upstream/<default-branch>     # or rebase, per the table
```

Keep `origin` = your fork, `upstream` = the source. Never push to `upstream`.
