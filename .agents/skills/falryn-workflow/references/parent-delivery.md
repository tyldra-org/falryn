# Parent delivery

A parent tracks an integrated outcome. It never owns an implementation branch
or one large PR. Parent sequencing needs authenticated Roadmap authority and the
current [audit](governance-audits.md). Do not reconstruct order from issue numbers
or recency. These rules also apply to Docs parent selectors.

## Choose the child scope

Manual Implement uses the same child selection below and stops at that child's
PR. The full delivery and continuation rules here apply only inside Deliver.

`Deliver - Target: Parent issue #N` selects the first ordered, unblocked,
incomplete child. Resolve ownership before starting; another assignee is a
boundary. If that child Needs Planning, plan it in Deliver. If it Needs Decision,
stop at its named owner. Do not bypass it for a later Ready sibling.

Deliver that child through required companions, merge, reconciliation and safe
checkout synchronization. If children remain, stop and report the exact next
child from a fresh generation. The one-child selector does not authorize it.

`Deliver - Target: Parent chain #N` authorizes the remaining ordered child scope.
Run the same [Deliver controller](deliver.md) for each child serially. Recompute
the authoritative sequence after every settled child. Do not begin the next
implementation while the current child's checks, merges or reconciliation remain
pending. Reuse unchanged guidance, but resolve each handoff against the new
baseline and establish its own validation and merge evidence.

## Complete or resume

Apply [execution rules](execution.md) to changed facts, unavailable authority,
uncertain effects and repairs without progress. A routine precondition change
requires refreshed evidence; an unresolved blocker or decision pauses the chain
at the exact child. Report completed members and the exact chain resume selector.

Keep the parent In Progress while required work remains. After its last child,
[Verify](assessment.md#verify) every integrated parent criterion before closing
and marking Done. Child closure alone is insufficient. An integration code gap
becomes one dedicated native child; do not hide it in a completed sibling.
