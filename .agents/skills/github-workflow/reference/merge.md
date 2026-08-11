# merge

Integration merges and the topology they produce.

## Merge strategy by intent

| Intent | Strategy | Why |
|---|---|---|
| Land a GitHub PR into its base | Repository-selected or required method | Rulesets, settings, contribution guidance, and observed history control |
| Preserve an integration or release lane locally | `--no-ff` when topology requires it | The merge commit records the join |
| Keep a small tidy PR history | squash when enabled and customary | One commit per PR; loses intra-branch commits |
| Keep a strictly linear history | rebase-merge when policy requires it | No merge commits; rewrites branch SHAs |
| Update your branch from the default branch | see [sync.md](sync.md) | Different problem |

**The repo already has an answer.** Inspect repository settings and rules, contribution guidance, recent merged PRs, and `git log --graph --oneline -30`. Do not infer the method from history alone when GitHub enforces or queues a different method.

## Merge a GitHub pull request

Immediately before confirmation, resolve and show:

- exact repository and PR;
- base branch, head branch, and current head SHA;
- required checks, reviews, mergeability, and merge queue state;
- repository-selected merge method;
- final merge or squash subject; the merge result has no body.

Query the current head SHA directly:

```bash
gh pr view <n> --repo <owner/repo> \
  --json number,url,baseRefName,headRefName,headRefOid,mergeStateStatus,statusCheckRollup
```

Compare `headRefOid` with the SHA recorded by [review.md](review.md). If they differ, stop and review the new revision. Never substitute the new SHA into the merge command merely to make the lease pass.

For a squash merge, preview the exact PR-title-derived subject and an empty
body. Never copy the PR description into the merge result. If the repository or
platform requires a non-empty body, stop and report the incompatibility; do not
ask for or add one.

Bind the merge to the reviewed head:

```bash
gh pr merge <n> \
  --repo <owner/repo> \
  --match-head-commit <reviewed-head-sha> \
  --merge
```

Use `--squash` or `--rebase` only when repository policy selects it. Do not use `--admin`, `--auto`, or `--delete-branch` unless separately authorized.

When policy selects squash, pass the reviewed subject and an explicit empty body
so the PR description is not copied into the merge result:

```bash
gh pr merge <n> --repo <owner/repo> --match-head-commit <reviewed-head-sha> \
  --squash --subject "<reviewed subject>" --body ""
```

Never use `--body-file` for a commit or merge result.

Require checks and reviews to complete before invoking the merge by default. On a branch governed by a merge queue, `gh pr merge` can enable deferred or automatic landing even without an explicit `--auto` flag. Treat that as auto-merge: explain that the command will queue or defer the PR and obtain separate authorization before invoking it.

Afterward, re-read the PR and verify:

- state is `MERGED`, not merely queued or auto-merge-enabled;
- resulting commit, base branch, and merge time;
- expected checks, issue-closing effects, and downstream automation;
- merge/squash subject and confirm that the body is absent;
- local checkout state, following [sync.md](sync.md#synchronize-the-default-checkout-after-merge).

For coordinated PRs, use [delivery.md](delivery.md). Branch deletion remains a separate destructive action.

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
