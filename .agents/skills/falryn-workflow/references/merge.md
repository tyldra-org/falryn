# Merge

Merge is a separate, explicit manual action. Read the Merge requirements in the
canonical Development contract and the exact current Verify result first.

Merge only when the user sent Merge — Target: PR #N and the named PR has a
fresh passing Verify that previewed its exact squash subject, optional footer,
and available local checkouts.

Before merging, re-read the PR head, required check, review, mergeability
result, repository setting, previewed checkout, and default branch.
Any change invalidates the preview: stop and require a fresh Verify.

- Squash merge when it is enabled. Keep the reviewed PR title as the
  conventional-commit subject; do not invent a body.
- Reconcile closed issues, Project status, parent progress, documentation, and
  CURRENT-STATE.md after the complete bundle lands.
- Only then return each available clean, attached checkout to its fetched
  default branch with fast-forward-only semantics. Never stash, reset, rebase,
  force, or discard work to make synchronization succeed.

Read [Reporting](reporting.md) before finishing.
