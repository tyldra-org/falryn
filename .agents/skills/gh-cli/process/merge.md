# merge

Land a GitHub pull request. Local `git merge` is **git-workflow**. Native Origin PRs are **origin-cli**.

## Host

| Setup | Merge with |
| --- | --- |
| github.com primary, or Origin **inbound** mirror | **`gh pr merge`** on the GitHub source repo |
| native / detached Origin | **`origin pr merge`** — **origin-cli** |

When `git remote origin` is **`origin.cursor.com`** but **`mirrorStatus: inbound`**:

- **Push:** `git push origin` (**git-workflow**)
- **PRs:** **`gh pr create/view/checks/merge`** on the GitHub source repo — `origin pr create` fails

Use slugs from the project `AGENTS.md` if it names them, else `git remote get-url origin` / `gh repo view`.

**Anti-pattern:** `gh pr merge --squash --delete-branch` without `--match-head-commit`, `--subject`, and `--body ""`.

## Merge a GitHub pull request

The repo already has an answer. Inspect repository settings and rules, contribution guidance, recent merged PRs. Do not infer the method from history alone when GitHub enforces or queues a different method.

| Intent | Strategy |
|---|---|
| Land a GitHub PR into its base | Repository-selected or required method |
| Keep a small tidy PR history | squash when enabled and customary |
| Keep a strictly linear history | rebase-merge when policy requires it |

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

Require checks and reviews to complete before invoking the merge by default.
Wait for green via [ci.md](ci.md): background
`gh run watch RUN_ID --exit-status`, not a foreground wait. Re-read head
SHA and required checks immediately before merge.
On a branch governed by a merge queue, `gh pr merge` can enable deferred or
automatic landing even without an explicit `--auto` flag. Treat that as
auto-merge: explain that the command will queue or defer the PR and obtain
separate authorization before invoking it.

Afterward, re-read the PR and verify:

- state is `MERGED`, not merely queued or auto-merge-enabled;
- resulting commit, base branch, and merge time;
- expected checks, issue-closing effects, and downstream automation;
- merge/squash subject and confirm that the body is absent;
- local checkout state, following **git-workflow** [sync.md](../../git-workflow/reference/sync.md#synchronize-the-default-checkout-after-merge).

For coordinated PRs, use [delivery.md](delivery.md). Branch deletion remains a separate destructive action (**git-workflow**).
