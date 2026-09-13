# Merge a verified PR

Use `gh pr merge` for GitHub landing; local `git merge` belongs to `git-operations`.
The repository chooses the method, queue requirements and completion policy.
Apply [authorization and evidence](../SKILL.md#authorization-and-evidence).

## Establish the candidate

Read the exact repository and PR, base/head SHAs, checks, reviews and unresolved
threads, mergeability, rules and required companions. Resolve the final subject,
body and trailers according to the chosen method and repository policy.
Required checks and reviews must satisfy that policy before direct landing. Use
the [CI waiter](ci.md) for pending checks; do not invoke merge as a way to bypass
verification. A required queue follows its own verified admission conditions.

```bash
gh pr view <n> --repo <owner/repo> \
  --json number,url,baseRefName,baseRefOid,headRefName,headRefOid,mergeStateStatus,statusCheckRollup
```

This command is part of acquisition; it does not include every review or ruleset.
Use [review](review.md), [CI](ci.md) and repository settings for missing evidence.
A changed head or base requires reassessing the complete resulting diff and
refreshing affected checks. Never substitute a new SHA merely to pass the guard.

An existing request covering delivery can retain authority through that refresh.
An approval explicitly restricted to one revision or message stays restricted.
If authority is missing, finish the concrete preview before asking for it.

## Apply the selected method

Bind the reviewed head and message explicitly for a merge commit:

```bash
gh pr merge <n> --repo <owner/repo> --match-head-commit <reviewed-head-sha> \
  --merge --subject "<reviewed subject>" --body-file <reviewed-body-file>
```

Use `--squash` instead of `--merge` when selected. Use `--body ""` only when the
complete reviewed message has no body. With `--rebase`, inspect the existing
commit messages; do not claim a synthesized subject/body will replace them.
Check installed help before relying on a flag or queue behavior.

Immediately before invoking, re-read revision and live merge preconditions.
A lease protects the head, not every base or policy fact. Do not bypass rules with
`--admin`. Add `--auto` or `--delete-branch` only when the requested scope includes
those effects. A required queue may defer landing without an explicit auto flag;
explain that result and verify whether the user's scope covers deferred landing.

## Verify the effect

Read the PR again. Distinguish queued or auto-merge-enabled from `MERGED`. Record
the resulting commit and verify its base and complete message. Check the expected
issue and workflow effects. If the response was uncertain, inspect before retrying.

Reconcile only authorized fields through [issue lifecycle](issue-lifecycle.md).
Synchronize eligible local checkouts through
[git-operations](../../git-operations/reference/delivery-checkout.md). A merge does not
by itself authorize branch deletion or publishing a release.
For dependent PRs, use [delivery](delivery.md).
