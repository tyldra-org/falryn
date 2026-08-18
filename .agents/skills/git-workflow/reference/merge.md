# merge

Local integration merges and the topology they produce. Landing a **pull request** is not this file — **gh-cli** `process/merge.md` (github.com) or **origin-cli** `reference/pr.md` (native Origin).

## Merge strategy by intent

| Intent | Strategy | Why |
|---|---|---|
| Preserve an integration or release lane locally | `--no-ff` when topology requires it | The merge commit records the join |
| Keep a strictly linear local history | rebase then fast-forward | No merge commits; rewrites branch SHAs — [rewrite.md](rewrite.md) / [sync.md](sync.md) |
| Update your branch from the default branch | see [sync.md](sync.md) | Different problem |

**The repo already has an answer.** Inspect contribution guidance and `git log --graph --oneline -30`.

## Local integration merge

```bash
git switch <default-branch>
git fetch origin
git merge --ff-only origin/<default-branch>     # confirm you're current
git merge --no-ff <branch> -m "Merge branch '<branch>'"
```

Use `--no-ff` only when the repository's topology deliberately records integration or release lanes. A normal feature branch does not gain that requirement merely because it can fast-forward.

When the repository uses this local topology, its established administrative subject wins. A common form is:

```text
Merge branch '<branch>'
```

Do not invent a conventional-commit type for an administrative merge unless repository policy requires one.

## Verify the merge

```bash
git rev-parse '<default-branch>^{tree}' '<branch>^{tree}'
```

For a local merge whose only new content is the branch and whose base did not move, these trees should match. Otherwise verify the merge result against both parents and inspect the merge's own contribution:

```bash
git diff <branch> <default-branch>
git show --remerge-diff <merge-sha>
```

## Conflicts

Same rule as everywhere: **stop and ask**. Full procedure in [sync.md](sync.md#conflicts).

Never resolve a conflict in a merge you did not fully read. A merge conflict resolution is an invisible edit — it appears in no diff of any individual commit, only in `git show -m <merge>`. That's exactly where mistakes hide.

After resolving, before committing the merge:

```bash
git diff --cached                # the full resolution
git show -m HEAD                 # after commit: the merge's actual contribution
```

## Reverting a merge

Reverting a merge needs `-m` to say which parent to keep:

```bash
git revert -m 1 <merge-sha>      # -m 1 = keep the branch you merged INTO
```

Confirm before doing this, and flag the consequence: after reverting a merge, re-merging that branch will **not** restore the changes, because git considers them already merged. The branch has to be reverted-the-revert or rebuilt. Say this before doing it, not after.

## Fast-forward-only merges

For genuinely linear repos:

```bash
git merge --ff-only <branch>
```

Refuses rather than creating a merge commit. Good default for pulling the default branch; a failure means you have local commits you didn't expect.

## Octopus merges

Don't. Merging three branches at once produces a commit nobody can bisect through or revert cleanly. Merge them one at a time.
