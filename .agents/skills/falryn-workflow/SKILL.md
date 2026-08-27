---
name: falryn-workflow
description: >-
  Coordinate Falryn's optional Plan, Implement, Review, Verify, Merge, Deliver,
  and Next modes, plus read-only Falryn project orientation and next-step
  routing.
  Use for a named mode, a request for what is next, or a greeting, walkthrough,
  or status question in a Falryn checkout. Not for unrelated chat.
---

# Falryn workflow

Use this skill for optional maintainer modes and for read-only project
orientation. A greeting, `hello`, walkthrough, status question, or "what next?"
request in a Falryn checkout is orientation: route it through [Next](references/next.md)
and finish with its suggested prompt. It coordinates the Falryn-specific
contract; it does not replace the technical, Git, or GitHub skills required by
the work.

The canonical contract is
[falryn-docs/DEVELOPMENT.md](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md).
Use the local `falryn-docs` checkout when it is available. Read the relevant
mode there first. If it conflicts with this skill, the contract wins.

## Before acting

1. Resolve the target in this Falryn repository. Issues, Parents, PRs, and
   milestones use their native GitHub identity; documentation work follows the
   same issue and pull-request model.
2. Read the target, its native hierarchy, blockers, canonical design owners
   from DOCUMENTATION-MAP.md, current source, and CURRENT-STATE.md. Stop on a
   missing or conflicting product contract.
3. Load the supporting skills required by the work: gh-cli for GitHub state,
   PRs, checks, and merges; git-workflow for Git operations; and the relevant
   stack skill before code changes.
4. Read [Issue governance](references/issue-governance.md) before creating,
   editing, routing, or implementing a work issue.

## Select one mode

Read only the guide for the requested mode, plus any guide it explicitly
links. These guides complement the canonical contract rather than copying it.

| Prompt | Read |
| --- | --- |
| Plan — Target: ... | [Plan](references/plan.md) |
| Implement — Target: ... | [Implement](references/implement.md) |
| Review — Target: PR #N | [Review](references/review.md) |
| Verify — Target: ... | [Verify](references/verify.md) |
| Merge — Target: ... | [Merge](references/merge.md) |
| Deliver — Target: Issue #N | [Deliver](references/deliver.md) |
| Deliver — Target: Parent issue #N or Parent chain #N | [Deliver](references/deliver.md) and [Parent delivery](references/parent-delivery.md) |
| Next — Target: Falryn Roadmap or “what should I implement next?” | [Next](references/next.md) |
| Greeting, `hello`, project walkthrough, or status question in a Falryn checkout | [Next](references/next.md), read-only only |
| A Verify gap or incomplete, closed, or merged PR | [Corrections](references/corrections.md) |

## Shared invariants

- Manual Plan, Implement, Review, Verify, and Merge remain separate
  user-directed modes. Review is a code and blast-radius assessment; Verify is
  a delivery-readiness audit. Neither a Review nor a Verify result authorizes
  Merge.
- Deliver is the sole composite mode. One controller owns its target and runs
  readiness, implementation, verification, repair, and authorized delivery
  serially. Do not create phase or goal-wrapper agents.
- One PR-sized native child or standalone issue gets one focused branch and
  delivery PR. A parent is an outcome tracker, never a branch or mega-PR.
- Every work issue must have the governance metadata described in
  [Issue governance](references/issue-governance.md). Only its sole assignee's
  authenticated GitHub account may start Implement or Deliver; other accounts
  may plan, verify, or route it without taking it over.
- Classify documentation impact before planning or implementation as create,
  update, verify-unaffected, or not-applicable. Canonical documentation changes
  land with their owning code change in the same focused pull request.
- Re-read live GitHub state before every state-changing decision. Issues,
  Project fields, automation, and a green CI run never substitute for observed
  source, documentation, and validation.

## Reports

Report the resolved target, state changes, validation, and any blocker or
limitation. Every mode and project-orientation response finishes with one
exact, copy-ready Suggested next prompt line. It is navigation, never
permission to start another mode.

Read [Reporting](references/reporting.md) when choosing that line or naming
files. A running Parent chain with remaining siblings is the exception: keep
working in the same run instead of ending with a resume prompt.

## Distribution

Keep the vendored `falryn/.agents/skills/falryn-workflow/` package and the
maintainer-global `~/.agents/skills/falryn-workflow/` package byte-identical.
The repository sync helper includes this package. This Falryn-specific skill is
the deliberate exception to the portable-skill rule. Universal and stack
skills must remain product-agnostic.
