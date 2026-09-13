# Plan

Plan completes one issue's implementation contract. It may edit that issue and
its native hierarchy and blockers, and reconcile planning metadata when
Roadmap-owned. It does not implement source or documentation, create an
implementation branch or PR, set In Progress, close the issue or merge.

## Establish the contract

Use [issue governance](issue-governance.md) for the handoff and admission rules.
Compare the named issue, relevant native relationships and PRs with current
source, tests, manifests and `CURRENT-STATE.md`. For docs-only work, read the
canonical owners and source evidence needed for their claims.

Resolve missing facts that the evidence can answer. Split an outcome into native
PR-sized children when separate deliveries are needed. Preserve issue-specific
acceptance, non-goals and ownership; do not weaken them to avoid a prerequisite.
Classify [documentation impact](documentation-delivery.md). Read owners only
for affected contracts and keep public handoffs independently implementable.

## Record the result

For Roadmap leaves, keep Status Todo. Missing derivable facts mean Needs Planning.
A human-owned choice means Needs Decision with the exact line
`Decision required: @owner — question` in the owning issue. After the decision,
return to Needs Planning until the remaining contract is verified. Mark Ready
only when the current contract and metadata pass; an open blocker still prevents
implementation. Use [field transitions](roadmap-fields.md) and the required
[audits](governance-audits.md) after mutations.

Parent contracts retain Parent readiness and their valid parent Status; planning
a parent does not mark it Ready or start a child implementation.

Outside the Roadmap, complete the repository's public contract without inventing
private fields or adopting the issue. Missing required private authority is an
unavailable result for that operation, not a fabricated readiness claim.

Report the issue changes, contract completeness, blockers, decisions and missing
evidence through [mode reporting](targets-and-transitions.md#report-the-result).
Inside Deliver, continue when implementation is admitted.
