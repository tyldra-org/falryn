# Corrections

Resolve a verified gap from current public GitHub and repository state.

- **Open pull request:** keep the same issue, branch, PR, and still-valid companions. Add focused commits. Every pushed head requires fresh review and Verify before merge under [target invalidation](targets-and-transitions.md#invalidation).
- **Closed without merge:** reopen only when the head branch, base, scope, issue, and companion set remain valid. Otherwise create a fresh replacement delivery.
- **Merged but incomplete original acceptance:** reopen the owning issue, reconcile stale private Project completion when accessible, and use a fresh branch from the current default branch. Never reuse the squash-merged branch.
- **Distinct new outcome:** create one focused follow-up issue instead of expanding completed acceptance.

For an approved issue-free maintenance PR, preserve that PR-owned scope while
it remains open. If already merged and incomplete, establish a focused
correction owner and fresh PR; there is no owning issue to reopen and the
merged PR cannot be reused. Apply the same state rules in the resolved docs or
application repository.

Do not mutate source during Verify, edit a merged pull request, treat a previous merge approval as current, or blindly retry a possibly completed external effect. Preserve exact partial-delivery evidence.

A correction must change observable evidence, such as source, tests, diagnostics, dependency state, or a delivery precondition. After repair, review and verify the new exact revision. Inside Deliver these are controller steps, not reasons to hand the user new manual-mode prompts.

If private authority is required but unavailable, public diagnosis and issue/PR preparation may continue. Private Project or docs reconciliation remains an explicit maintainer action and cannot be inferred.
