# Plan

Plan makes one public Falryn issue implementation-ready without writing product code.

## Public evidence

Read the issue, native hierarchy and blockers, source, tests, manifests, `CURRENT-STATE.md`, repository guidance, and relevant public pull requests. Resolve:

- exact outcome, baseline, included behavior, and non-goals;
- one PR-sized owner or native child split;
- dependency and neighboring-owner boundaries;
- contracts, edge cases, resource and safety limits;
- failures, cancellation, partial and unavailable outcomes, recovery, and cleanup;
- product composition and user-facing projections;
- focused validation and documentation impact; and
- a current non-empty Ready checklist.

The issue body must preserve every issue-specific fact an implementer cannot safely infer. Private documentation may guide an authenticated maintainer, but no required implementation fact may exist only there. Classify canonical owners through [documentation delivery](documentation-delivery.md).

Plan may update the public issue, its native hierarchy, and blockers. It does not create implementation branches or pull requests, write source, set In Progress, close an issue, or merge anything.

## Access outcomes

With private Roadmap access, reconcile Project metadata and mark Ready only when all public and private preconditions pass, then run [governance audits](governance-audits.md). Without it, Plan may complete the public handoff but must report `private-roadmap-unavailable`; it cannot claim authoritative readiness or sequence position.

A missing product decision remains Not Ready. Do not invent it, copy broad private design into the public issue, or begin implementation while planning.

## Result

Report the exact issue, edits made, observed blockers, public-contract completeness, private-authority state, and first safe action. Use [reporting](reporting.md).
