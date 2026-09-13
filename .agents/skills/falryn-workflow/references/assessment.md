# Review and verification

Review assesses correctness of a PR revision. Verify determines whether the
selected outcome is complete and, for a delivery PR, whether its exact bundle is
ready to merge. Neither permits product or documentation repair or merge.

## Shared evidence

Resolve the exact repository, target, base and head SHAs, delivery owner and
complete diff. Inspect source, tests and the issue's acceptance, plus the
[documentation result](documentation-delivery.md) where applicable. Distinguish
application ownership, docs-only work, companions and approved issue-free PRs
through [target resolution](targets-and-transitions.md#resolve-a-delivery-target).

Use existing checks only for their proven inputs. Never execute an untrusted PR
head in a privileged maintainer checkout. Follow `change-review` and the host's
trust rules for an authorized isolated reproduction. Private evidence that
cannot be inspected is unavailable; it is not an implementation defect or a
verified-unaffected result.

## Review

Load `change-review`, `gh-cli` and the relevant stack skill. Apply the review
procedure once to the complete current diff. Trace affected callers, contracts,
state, failure paths and user-facing behavior, including changes outside the
immediate hunks. Identify the central invariant and the evidence that supports it.

Report the revision, changed-file inventory, behavior, actionable findings,
cleared risks, observed checks and missing evidence using `change-review`.
No findings is a valid result; it is not proof that the full bundle can merge.
Do not edit, post comments or reviews, approve, change Project state or merge.
Inside Deliver, the controller may act on findings under its existing authority.

## Verify

Verify the target's acceptance and completion proof:

| Target | Required scope |
| --- | --- |
| PR | Exact application or docs revision, owner acceptance and required companions |
| Leaf issue | Every acceptance criterion and actual delivered behavior |
| Parent | Required children plus integrated behavior, failure, recovery, resource, security, documentation and projection criteria |
| Target release or range | Requested private scope with Roadmap and documentation authority |

For PRs, inspect required checks, reviews and threads, rulesets, mergeability,
repository settings, documentation disposition and clean local checkout state.
Public-only verification can establish public acceptance. It cannot establish
full delivery readiness while required private documentation remains unresolved.

A passing merge preview records each repository and PR, exact reviewed base and
head SHA, delivery owner and companion links, required checks and reviews,
[merge order](merge.md#merge-the-bundle), squash subject and empty body or one
useful short issue-reference footer, and eligible local default checkouts.
Changes to these facts invalidate the affected preview under [execution](execution.md).
Do not merge from Verify.

Verify may perform only governance reconciliation explicitly authorized by the
user, such as correcting issue state, reopening incomplete work, recording a
missing delivery owner or closing a fully proven parent. Use
[recovery](deliver.md#recover-from-observed-state) for the correct owner and
[audits](governance-audits.md) before readiness, sequence, liveness or complete
reconciliation claims. Diagnose other gaps and report the next permitted action.

End either assessment with [mode reporting](targets-and-transitions.md#report-the-result).
