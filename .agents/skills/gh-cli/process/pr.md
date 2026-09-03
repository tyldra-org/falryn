# Pull requests

Create and maintain GitHub pull requests. Use `git-workflow` for fetch, branch, commit, push, rewrite, and checkout synchronization.

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

Render the complete title and body before creation. A user's explicit request to open the named PR—including a draft—is sufficient authorization; do not ask again unless the target, visibility, or content is materially ambiguous.

Use the repository's installed CLI help for current flags:

```bash
gh pr create --help
gh pr edit --help
```

After creation, re-read the PR and report its URL, base, head, and head SHA.

## Updates

Push focused follow-up commits through `git-workflow`, then re-read the PR. A new head SHA invalidates earlier review and merge evidence.

When replacing title or body, first read the current value, prepare the complete replacement in a file, preserve out-of-scope fields, write once, and re-read. Never pipe an unchecked transformation into a remote edit.

Choose continuation from actual state:

- **Open:** update the existing branch and PR.
- **Closed unmerged:** inspect why; reopen only if target, branch, policy, and scope still hold, otherwise open a fresh PR.
- **Merged:** create a focused follow-up from the current target branch; never reuse the merged record as mutable work.

Do not force-push a reviewed PR unless explicitly authorized through `git-workflow`; a rewrite changes the evidence base.

## Landing

Merge only through [merge.md](merge.md) or, for dependent PRs, [delivery.md](delivery.md). Confirmation must identify the exact reviewed target and revision, or an exact ordered bundle of reviewed revisions. Re-read head SHA, checks, reviews, rulesets, mergeability, and repository merge method immediately before invoking the merge.

Do not silently enable auto-merge, administrative bypass, queueing, or branch deletion.
