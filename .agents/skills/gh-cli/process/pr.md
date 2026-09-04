# Pull requests

Create and maintain GitHub pull requests. Use `git-workflow` for fetch, branch, commit, push, rewrite, and checkout synchronization.

## Inspect and select

```bash
gh pr list --repo OWNER/REPO --state all --limit 100 \
  --json number,title,state,isDraft,baseRefName,headRefName,headRefOid,url
gh pr view NUMBER --repo OWNER/REPO \
  --json number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,reviewDecision,statusCheckRollup
```

Use the PR number or URL in mutations. Branch names can be ambiguous across forks and can change. Record the head SHA whenever the decision depends on reviewed code.

## Inspect before opening

Resolve the repository, default branch, intended head, and current head SHA. Review the three-dot branch diff and commit range through `git-workflow`; confirm the branch is pushed, current enough for repository policy, secret-free, and based on the intended branch.

For stacked PRs, use the parent branch as base and disclose the stack and landing order.

## Title and body

Follow repository templates and conventions. In a squash-merge repository, remember that the title may become the commit subject. Keep validation, risk, rationale, delivery order, issue links, and companion links in the PR body; do not copy them into a subject-only commit or merge message when repository policy forbids bodies.

A useful fallback body is:

```markdown
## What
What changed and what it enables.

## Why
The problem and owning issue.

## Verification
Commands or observed checks and their outcomes.

## Risk
Blast radius, migration, rollback, or an explicit none.
```

Render the complete title and body before creation. A user's explicit request to open the named PR, including a draft, is sufficient authorization; do not ask again unless the target, visibility, or content is materially ambiguous.

Use the repository's installed CLI help for current flags:

```bash
gh pr create --help
gh pr edit --help
```

Do not treat `gh pr create --dry-run` as side-effect free. Current CLI help warns that it may still push Git changes. To preview safely, inspect the local diff, render title/body, and resolve base/head without invoking a command that can publish a branch.

Current CLI versions can upload image or video attachments on create and edit. Validate privacy, file type, size, alt text, and content. Attachment upload is not atomic: the PR may be created or edited with a subset of files and a nonzero exit status. Capture the printed URL and re-read the PR before recovery or retry.

After creation, re-read the PR and report its URL, base, head, and head SHA.

## Checkout for local inspection

`gh pr checkout` mutates local Git state, so also follow `git-workflow`. Prefer a separate worktree or a deliberate detached checkout for untrusted review work:

```bash
gh pr checkout NUMBER --repo OWNER/REPO --worktree <review-path>
gh pr checkout NUMBER --repo OWNER/REPO --detach
```

Verify that the checked-out SHA equals `headRefOid`. Never use `--force` to overwrite an existing local branch. Do not use `--recurse-submodules` until `.gitmodules` and every submodule source have been inspected.

## Updates

Push focused follow-up commits through `git-workflow`, then re-read the PR. A new head SHA invalidates earlier review and merge evidence.

When replacing title or body, first read the current value, prepare the complete replacement in a file, preserve out-of-scope fields, write once, and re-read. Never pipe an unchecked transformation into a remote edit.

Choose continuation from actual state:

- **Open:** update the existing branch and PR.
- **Closed unmerged:** inspect why; reopen only if target, branch, policy, and scope still hold, otherwise open a fresh PR.
- **Merged:** create a focused follow-up from the current target branch; never reuse the merged record as mutable work.

Do not force-push a reviewed PR unless explicitly authorized through `git-workflow`; a rewrite changes the evidence base.

## Lifecycle operations

```bash
gh pr ready NUMBER --repo OWNER/REPO
gh pr ready NUMBER --repo OWNER/REPO --undo
gh pr comment NUMBER --repo OWNER/REPO --body-file <reviewed-body-file>
gh pr close NUMBER --repo OWNER/REPO
gh pr reopen NUMBER --repo OWNER/REPO
```

Ready/draft state, comments, close/reopen, locking, labels, assignees, reviewers, milestones, and base changes are visible collaboration records. An explicit request naming the target and change authorizes that non-destructive update. Preview text and re-read state afterward. Do not couple `--delete-branch` to close or merge unless branch deletion was separately authorized.

Comments can also upload attachments and can edit or delete the caller's last comment. Treat attachment partial success like create/edit. Deleting or replacing an existing comment requires the same pre-image, preview, and verification safeguards as another remote body replacement.

Updating a PR branch mutates the contributor branch and can invalidate reviews or trigger CI. The default `gh pr update-branch` behavior merges the base into the head; `--rebase` rewrites the head. Inspect repository policy, current SHAs, branch ownership, and required authorization before either form, then re-read the new head SHA.

## Landing

Merge only through [merge.md](merge.md) or, for dependent PRs, [delivery.md](delivery.md). Confirmation must identify the exact reviewed target and revision, or an exact ordered bundle of reviewed revisions. Re-read head SHA, checks, reviews, rulesets, mergeability, and repository merge method immediately before invoking the merge.

Do not silently enable auto-merge, administrative bypass, queueing, or branch deletion.
