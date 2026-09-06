# Plan

Plan completes the contract for one resolved Falryn or docs-only issue without
implementing it. Resolve repository ownership through
[targets and transitions](targets-and-transitions.md), then use the issue
format required by [issue governance](issue-governance.md). A docs-only target
requires Docs access and its repository guidance; private content stays there.

Apply [shared execution efficiency](execution-efficiency.md) within Plan's permissions. Reuse current evidence without omitting any required handoff fact or beginning implementation.

## Contract evidence

Read the issue, native hierarchy and blockers, repository guidance, and relevant
PRs. For implementation claims, inspect source, tests, manifests, and
`CURRENT-STATE.md`. For docs-only work, read affected canonical owners and the
source evidence needed for their claims. Resolve the applicable facts:

- exact outcome, baseline, included behavior, and non-goals;
- one PR-sized owner or native child split;
- dependency and neighboring-owner boundaries;
- contracts, edge cases, resource and safety limits;
- failures, cancellation, partial and unavailable outcomes, recovery, and cleanup;
- product composition and user-facing projections;
- focused validation and documentation impact; and
- a current non-empty checklist for the selected format: Contribution for a
  public submission, Ready for a maintainer handoff. An adopted public form may
  retain its Contribution checklist.

The issue body must preserve every issue-specific fact an implementer cannot
safely infer. A public Falryn handoff cannot leave required implementation facts
only in private documentation. Docs-only contracts remain in their private
repository. Classify owners through [documentation delivery](documentation-delivery.md).

Plan may update the resolved issue, its native hierarchy, and blockers. For
docs-only planning, read the affected canonical owners and required source
evidence without editing the documentation deliverable. Plan does not create
implementation branches or PRs, write source, set In Progress, close an issue,
or merge anything.

## Access outcomes

For Roadmap-owned work, reconcile metadata and mark Ready only when all required
preconditions pass, then run [governance audits](governance-audits.md). If required
Roadmap access is missing, report `private-roadmap-unavailable`; do not claim
private readiness or sequence. An issue outside the Project needs only its
repository's contract and does not require Project access or adoption.

For Roadmap work, missing derivable facts mean Needs Planning. A human-owned
choice means Needs Decision and a `Decision required: @owner — question` line in
the owning issue. After the decision, return to Needs Planning until the contract
is verified. Outside the Project, report the missing fact or decision without
inventing private fields. Do not invent an answer, copy private design into a
public issue, or begin implementation while planning.

## Result

Report the exact issue, edits made, observed blockers, public-contract completeness, private-authority state, and first safe action. Use [reporting](../SKILL.md#reporting).
