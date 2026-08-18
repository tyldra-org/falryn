# recover

Getting work back. Committed or staged work is often recoverable while reflogs and unreachable objects are retained, but retention is configurable and garbage collection means there is no universal minimum recovery window.

## First, stop

Do not run more git commands hoping to fix it. Each one adds reflog noise, and `git gc` or another `reset` can turn recoverable into unrecoverable. Read state, then act once.

```bash
git status --short --branch
git reflog -30
git stash list
git fsck --lost-found 2>/dev/null | head -20
```

## The reflog is the answer to most of this

`git reflog` records every position HEAD held, including states no branch points to anymore.

```bash
git reflog                          # HEAD's history
git reflog show <branch>            # a specific branch's history
git reflog --date=iso -20           # with timestamps, to find "before I ran that"
```

Recover by pointing something at the lost SHA:

```bash
git branch recovered-<what> <sha>   # safest: a new branch, nothing else moves
git switch recovered-<what>
```

Always recover to a **new branch** first, inspect, then decide. Never `reset --hard` back to the lost SHA as the first move — that's another destructive operation on top of an unclear state.

## By symptom

### "I committed to the wrong branch"

```bash
git branch <correct-branch>          # mark current position
git reset --hard HEAD~N              # protected: back up first
git switch <correct-branch>
```

Or, without moving anything: `git cherry-pick` the commits onto the right branch, then remove them from the wrong one.

### "I need to undo the last commit"

Four different outcomes — pick deliberately:

| Want | Command | Working tree |
|---|---|---|
| Undo commit, keep changes staged | `git reset --soft HEAD~1` | untouched |
| Undo commit, keep changes unstaged | `git reset HEAD~1` | untouched |
| Undo commit, discard changes | `git reset --hard HEAD~1` | **destroyed** |
| Undo a *published* commit | `git revert <sha>` | new commit, safe |

Published → `revert`, always. The other three rewrite history.

### "I ran `reset --hard` and lost work"

Committed work: in the reflog, recoverable above.

Uncommitted work: **gone**, unless it was ever staged. Staged content becomes a dangling blob:

```bash
git fsck --lost-found
git show <dangling-blob-sha>
```

If it was never staged and never committed, git never saw it. Check the editor's local history / undo buffer instead — that's the only remaining copy.

### "I deleted a branch"

```bash
git reflog show <branch>            # often still works right after deletion
git fsck --lost-found | grep commit
git branch <branch> <sha>
```

If the branch was pushed, `git fetch origin <branch>` may simply bring it back.

### "I lost a stash"

```bash
git fsck --unreachable | grep commit | cut -d' ' -f3 | xargs git log --merges --no-walk
git stash apply <sha>
```

Dropped stashes are unreachable commits and survive until `gc`.

### "The rebase went wrong"

```bash
git rebase --abort                  # if still mid-rebase
git reset --hard ORIG_HEAD          # if it completed — protected, back up first
```

`ORIG_HEAD` holds the pre-rebase/pre-merge/pre-reset position. It's overwritten by the next such operation, so use it immediately or read the SHA off the reflog instead.

### "I force-pushed over someone's work"

Their commits still exist on any machine that has them, and in the remote's reflog if the host exposes it (many forges do not). Recovery path:

1. Ask whoever pushed to run `git reflog` locally — they almost certainly still have it.
2. Check open pull requests on the host — some forges retain force-pushed commits in the PR timeline and they remain fetchable by SHA: `git fetch origin <sha>`.
3. Check CI logs for the SHA, then `git fetch origin <sha>`.

Report the incident plainly. Don't quietly re-push and hope.

### "I committed a secret"

Do not start with history rewriting. See [audit.md](audit.md#secret-leak-response) — rotation first.

## Time limits

Unreachable-object and reflog expiry defaults are commonly measured in weeks or months, but repository and global configuration can shorten them, and maintenance may run automatically. Inspect the applicable expiry configuration rather than promising a deadline. **Never run `git gc --prune=now`, `git reflog expire`, or `git prune` while anything is unaccounted for.** Once the relevant object is pruned and no other clone has it, recovery may be impossible.
