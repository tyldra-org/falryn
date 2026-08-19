# delivery

Coordinate one logical change across multiple repositories or multiple dependent pull requests.

## Define the delivery bundle

Before changing remote state, record:

- the bundle owner and intended outcome;
- every repository and PR in scope;
- each repository's role, such as contract, implementation, documentation, deployment, or consumer;
- the required landing order and why it is safe;
- the reviewed head SHA of every PR;
- required checks, reviews, merge method, issue-closing behavior, and release or deployment follow-up;
- the final commit and merge messages are subject-only; no commit or merge body is allowed; PR bodies own the validation and delivery details;
- the local checkout, if any, associated with each repository.

Cross-repository delivery is sequential, not atomic. A bundle needs an order that keeps every intermediate remote state acceptable. If no safe order exists, introduce compatibility first or stop and redesign the delivery.

## Verify before merging

For every PR:

1. Review the complete diff and companion changes.
2. Confirm repository, base branch, head branch, and exact head SHA.
3. Confirm required checks, reviews, mergeability, and repository merge policy.
4. Confirm the PR body links the owning issue and companion PRs correctly.
5. Confirm the selected order will not leave a broken contract, deployment, or documentation state.
6. Preview what each local checkout will need after landing.

A passing companion PR does not compensate for a failing or stale member. If any reviewed head SHA changes, re-review that PR and any dependent assumptions before proceeding.

## Merge in the declared order

Confirm before the first merge and show the ordered PR set. Then merge one PR at a time using the repository-selected strategy and the reviewed head SHA:

```bash
gh pr merge <n> \
  --repo <owner/repo> \
  --match-head-commit <reviewed-head-sha> \
  --merge
```

Replace `--merge` with `--squash` or `--rebase` only when repository policy selects it. Do not add `--admin`, `--auto`, or `--delete-branch` implicitly.

After each merge:

- re-read the PR and verify `MERGED`, the resulting commit, base branch, and merge time;
- verify expected issue, Project, milestone, workflow, deployment, and release effects;
- check whether the merge entered a queue or enabled deferred merging rather than completing immediately;
- stop at the first unexpected result.

Require checks and reviews to complete before each invocation by default. If a repository requires a merge queue and the command would defer or automatically land the PR, obtain explicit authorization for that behavior before proceeding.

When a bundle stops partway through, report merged, pending, and failed members. Do not attempt rollback, force a later merge, or conceal the partial state.

## Reconcile remote state

After all merges complete, audit the bundle as one unit:

- every PR is merged at the reviewed revision or an explicitly re-reviewed revision;
- expected issues and parent rollups changed state correctly;
- companion links remain accurate;
- required workflows and deployments completed;
- release notes, changelogs, and documentation describe the landed state;
- no repository still presents the bundle as pending.

Per-issue Project status, assignees, and parent/child rollups: [issue-lifecycle.md](issue-lifecycle.md). Automation may update fields on close; always verify and repair.

## Synchronize local checkouts

Local cleanup happens only after remote delivery succeeds. For each checkout, follow **git-workflow** → [delivery-checkout.md](../../git-workflow/reference/delivery-checkout.md).

## Report

Report:

- bundle owner and landing order;
- each PR URL, reviewed head SHA, merge method, and resulting commit;
- merged, pending, failed, and skipped members;
- remote issue, Project, workflow, deployment, and release effects;
- each local checkout's final branch, upstream, cleanliness, and synchronization state;
- branches intentionally retained or separately approved for deletion.
