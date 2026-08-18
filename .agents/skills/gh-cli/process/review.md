# review

Review a PR, branch, or diff. Read-only by default — reviewing never edits the code under review.

## Get the diff

```bash
gh pr view <n> --repo <owner/repo> \
  --json number,url,baseRefName,headRefName,headRefOid,mergeStateStatus
gh pr diff <n>
gh pr checks <n>
```

Record `headRefOid` with the review. A later head SHA is a new revision and must not inherit the old review silently.

Or locally, for a branch:

```bash
git fetch origin
git diff origin/<default-branch>...<branch>       # three dots
git log origin/<default-branch>..<branch> --oneline
```

For a large PR, check out the branch (or a worktree) and read it in context. A diff hides what the surrounding code does, and most real defects are contextual.

## Read in this order

1. **The description.** What does the author claim this does?
2. **The commit list.** Does the history tell a coherent story? Are there checkpoint or revert-of-my-own-mistake commits that should have been squashed?
3. **Tests.** Read the tests before the implementation. They define the intended contract; the implementation is just one way to satisfy it. A change with no test change is a claim that behavior didn't change — verify that claim.
4. **The implementation.**
5. **What's missing.** The hardest and most valuable pass: the error path not handled, the migration not written, the caller not updated, the doc not changed.

For a cross-repository or dependent-PR delivery, review the complete companion set and the declared landing order using [delivery.md](delivery.md). “No findings” applies only to the scoped revision and companions actually reviewed.

## What to report

Order by severity. For each finding:

```
path:line — <what is wrong>. <what happens as a result>. <the fix>.
```

Severity:

- **Blocking** — correctness, data loss, security, breaking change without a migration, secret in the diff.
- **Should fix** — a real defect with a narrow trigger, missing test for a changed behavior, an API that will be painful to change later.
- **Consider** — design opinion, naming, structure. Say it once; do not litigate.
- **Nit** — skip unless it changes meaning. Formatting the linter didn't catch is noise.

**No praise padding.** No "great work overall!". No summary that restates the diff. If there are no findings, say there are no findings.

## Git-specific review checks

These are the ones that only exist at the VCS layer and get missed:

- **Secrets** in the diff, including in test fixtures and `.env.example` files that were "just examples".
- **Large or binary files** newly tracked. `git diff --stat` outliers; anything over ~1MB should be justified or moved to LFS.
- **Lockfile drift** — a dependency change with no lockfile update, or a lockfile update with no dependency change.
- **Generated files** committed without their source, or source changed without regenerating.
- **Base branch** wrong — the diff contains commits from another feature.
- **Merge commits inside a feature branch** in a repo that squashes. Cosmetic there; structural in a merge-commit repo.
- **Revert-of-a-revert** without explanation.
- **`.gitignore` deletions** — often accidental, and they cause future accidental commits.
- **Line-ending churn** — a whole file showing as changed with no visible diff means CRLF/LF. Check `.gitattributes` before blaming the author.
- **File mode changes** (`old mode 100644 / new mode 100755`) — usually accidental, occasionally security-relevant.

## Submitting

Posting a review is an outward-facing action — **ask before submitting**, and show the user the text first.

```bash
gh pr review <n> --comment --body-file <path>
gh pr review <n> --request-changes --body-file <path>
gh pr review <n> --approve
```

Never `--approve` on the user's behalf without explicit instruction naming that PR. Approval is a signature.

## Reviewing your own work before pushing

Same procedure, applied to `git diff origin/<branch>..<branch>`. Worth doing on anything above trivial size — most of what a reviewer would catch, you can catch first, and the ones you catch cost nothing.
