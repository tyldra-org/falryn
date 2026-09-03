# Correction delta

Canonical owner: [`DEVELOPMENT.md#correcting-work-before-and-after-merge`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md#correcting-work-before-and-after-merge).

- Valid open PR: correct the existing branch and PR, then verify the new head.
- Closed unmerged PR: reopen only when branch, base, scope, and policy still hold; otherwise create a fresh delivery.
- Merged but incomplete original acceptance: reopen the owning issue and use a fresh branch from current default.
- Distinct new outcome: create one focused follow-up issue.

Never mutate code during Verify, reuse a merged branch, treat a merged PR as editable, or retry an uncertain effect without reconciliation. A correction needs observable progress and returns through fresh Review/Verify evidence.
