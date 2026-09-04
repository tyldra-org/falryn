# merge

Land a GitHub pull request. Local `git merge` is **git-workflow**.

## Host

Use **`gh pr merge`** on the GitHub repository. Resolve the repository with the project `AGENTS.md` or `gh repo view`.

**Anti-pattern:** merging without `--match-head-commit` or without binding
message fields that the selected strategy permits the command to control.

## Merge a GitHub pull request

The repo already has an answer. Inspect repository settings and rules, contribution guidance, recent merged PRs. Do not infer the method from history alone when GitHub enforces or queues a different method.

| Intent | Strategy |
|---|---|
| Land a GitHub PR into its base | Repository-selected or required method |
| Keep a small tidy PR history | squash when enabled and customary |
| Keep a strictly linear history | rebase-merge when policy requires it |

Immediately before confirmation, resolve and show the exact target. Prior authorization is valid only when it already names this PR, reviewed head SHA, method, and final message; otherwise obtain confirmation now. An ordered bundle approval is governed by [delivery.md](delivery.md).

Resolve:

- exact repository and PR;
- base branch, head branch, and current head SHA;
- required checks, reviews, mergeability, and merge queue state;
- repository-selected merge method;
- final message required by repository and contributor policy, including any
  body or trailers that must be preserved;

Query the current head SHA directly:

```bash
gh pr view <n> --repo <owner/repo> \
  --json number,url,baseRefName,headRefName,headRefOid,mergeStateStatus,statusCheckRollup
```

Compare `headRefOid` with the SHA recorded by [review.md](review.md). If they differ, stop and review the new revision. Never substitute the new SHA into the merge command merely to make the lease pass.

For merge-commit and squash strategies, preview the exact final subject and
body required by repository and contributor policy. Do not let a mutable PR
description become the merge body by default. Use an explicit empty body only
when the effective policy requires subject-only messages; otherwise preserve the
reviewed body, footers, and trailers.

Bind the merge and reviewed message to the reviewed head. For a merge commit:

```bash
gh pr merge <n> --repo <owner/repo> --match-head-commit <reviewed-head-sha> \
  --merge --subject "<reviewed subject>" --body-file <reviewed-body-file>
```

Use `--body ""` instead of `--body-file` only for a reviewed subject-only
message. When policy selects squash, replace `--merge` with `--squash` while
keeping the reviewed message flags. A rebase merge synthesizes no single merge
commit; review the existing commit messages and use `--rebase` without claiming
that `--subject` or `--body` will rewrite them.

Do not use `--admin`, `--auto`, or `--delete-branch` unless separately
authorized. Keep a non-empty body in a validated temporary file rather than a
shell-interpolated multiline string.

Require checks and reviews to complete before invoking the merge by default. Wait through the native mechanism in [ci.md](ci.md), then re-read head SHA and required checks immediately before merge. The embedding host decides whether that waiter runs in the foreground or background.
On a branch governed by a merge queue, `gh pr merge` can enable deferred or
automatic landing even without an explicit `--auto` flag. Treat that as
auto-merge: explain that the command will queue or defer the PR and obtain
separate authorization before invoking it.

Afterward, re-read the PR and verify:

- state is `MERGED`, not merely queued or auto-merge-enabled;
- resulting commit, base branch, and merge time;
- expected checks, issue-closing effects, and downstream automation;
- final message and required body, footers, or trailers match the reviewed
  policy;
- local checkout state, following **git-workflow** [sync.md](../../git-workflow/reference/sync.md#synchronize-the-default-checkout-after-merge).

For coordinated PRs, use [delivery.md](delivery.md). Branch deletion remains a separate destructive action (**git-workflow**).
