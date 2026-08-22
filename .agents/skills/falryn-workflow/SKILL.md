---
name: falryn-workflow
description: >-
  Run Falryn's optional maintainer workflow: Plan, Implement, Verify, Merge,
  Deliver, or Next for Falryn and Falryn Docs. Use when a prompt names one of
  those modes and a target, or asks what to implement next. Not for ordinary
  contributor pull requests.
---

# Falryn workflow

Use this skill only for the optional maintainer modes. It coordinates the
Falryn-specific contract; it does not replace the technical, Git, or GitHub
skills required by the work.

The canonical contract is
[falryn-docs/DEVELOPMENT.md](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md).
Read the relevant mode there first, preferably from a current local
falryn-docs checkout. If it conflicts with this skill, the contract wins.

## Before acting

1. Resolve the target in the correct repository. Unqualified Issues, Parents,
   PRs, and milestones are Falryn; only targets prefixed with Docs are Falryn
   Docs. Never substitute a same-numbered object from the other repo.
2. Read the target, its native hierarchy, blockers, canonical design owners
   from DOCUMENTATION-MAP.md, current source, and CURRENT-STATE.md. Stop on a
   missing or conflicting product contract.
3. Load the supporting skills required by the work: gh-cli for GitHub state,
   PRs, checks, and merges; git-workflow for Git operations; and the relevant
   stack skill before code changes.

## Select one mode

Read only the guide for the requested mode, plus any guide it explicitly
links. These guides complement the canonical contract rather than copying it.

| Prompt | Read |
| --- | --- |
| Plan — Target: ... | [Plan](references/plan.md) |
| Implement — Target: ... | [Implement](references/implement.md) |
| Verify — Target: ... | [Verify](references/verify.md) |
| Merge — Target: ... | [Merge](references/merge.md) |
| Deliver — Target: Issue #N | [Deliver](references/deliver.md) |
| Deliver — Target: Parent issue #N or Parent chain #N | [Deliver](references/deliver.md) and [Parent delivery](references/parent-delivery.md) |
| Next — Target: Falryn Roadmap or “what should I implement next?” | [Next](references/next.md) |
| A Verify gap or incomplete, closed, or merged PR | [Corrections](references/corrections.md) |

The same routing applies to Docs issue, Docs parent issue, Docs parent chain,
and Docs PR targets. Docs-only work has no Falryn application delivery owner.

## Shared invariants

- Manual Plan, Implement, Verify, and Merge remain separate user-directed
  modes. A Verify result or a suggested prompt never authorizes Merge.
- Deliver is the sole composite mode. One controller owns its target and runs
  readiness, implementation, verification, repair, and authorized delivery
  serially. Do not create phase or goal-wrapper agents.
- One PR-sized native child or standalone issue gets one focused branch and
  delivery PR. A parent is an outcome tracker, never a branch or mega-PR.
- Classify documentation impact before planning or implementation as create,
  update, verify-unaffected, or not-applicable. Canonical documentation changes
  use a linked companion docs PR and land first.
- Re-read live GitHub state before every state-changing decision. Issues,
  Project fields, automation, and a green CI run never substitute for observed
  source, documentation, and validation.

## Reports

Report the resolved target, state changes, validation, and any blocker or
limitation. Finish with one exact, copy-ready Suggested next prompt line. It is
navigation, never permission to start another mode.

Read [Reporting](references/reporting.md) when choosing that line or naming
files. A running Parent chain with remaining siblings is the exception: keep
working in the same run instead of ending with a resume prompt.

## Distribution

The vendored copy under falryn/.agents/skills/falryn-workflow/ is the
contributor-facing source. Keep it aligned with the personal
~/.agents/skills/falryn-workflow/ copy, but do not make universal skills
Falryn-specific.
