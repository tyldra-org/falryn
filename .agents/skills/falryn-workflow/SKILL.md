---
name: falryn-workflow
description: Falryn-specific routing for optional Plan, Implement, Review, Verify, Merge, Deliver, and Next modes, plus read-only project orientation. Use only in Falryn or Falryn Docs work; all other skill bundles remain product-agnostic.
---

# Falryn workflow

The canonical contract is [`falryn-docs/DEVELOPMENT.md`](https://github.com/tyldra-org/falryn-docs/blob/main/DEVELOPMENT.md). Use a local `falryn-docs` checkout when available and read the exact requested mode there first. This skill routes to compact deltas; it never overrides or copies the canonical algorithm.

A Falryn greeting, walkthrough, status question, or “what next?” request is read-only orientation through [Next](references/next.md).

## Before acting

1. Resolve the exact repository and target using canonical selector rules. Never substitute a same-numbered object from the other repository.
2. Read the target, native hierarchy and blockers, Roadmap fields, canonical documentation owners, current source, and `CURRENT-STATE.md` as applicable.
3. Load `gh-cli` for GitHub, `git-workflow` for Git mutations, `change-review` for review reasoning, and the relevant stack or engineering skill.
4. Read [issue governance](references/issue-governance.md) before issue mutation, implementation, or routing.
5. Stop on missing canonical documents, unresolved readiness, unauthoritative hand-built sequencing, stale revision evidence, or conflicting ownership.

## Route one mode

| Request | Local delta |
| --- | --- |
| `Plan — Target: ...` | [Plan](references/plan.md) |
| `Implement — Target: ...` | [Implement](references/implement.md) |
| `Review — Target: PR #N` | [Review](references/review.md) |
| `Verify — Target: ...` | [Verify](references/verify.md) |
| `Merge — Target: ...` | [Merge](references/merge.md) |
| `Deliver — Target: Issue #N` | [Deliver](references/deliver.md) |
| `Deliver — Target: Parent issue #N` or `Parent chain #N` | [Deliver](references/deliver.md) and [Parent delivery](references/parent-delivery.md) |
| `Next — Target: Falryn Roadmap`, orientation, or status | [Next](references/next.md) |
| Verify gap; incomplete closed/merged delivery | [Corrections](references/corrections.md) |

## Non-negotiable boundaries

- Plan, Implement, Review, Verify, and Merge are separate manual modes. Review and Verify never authorize Merge.
- Verify is read-only for product source and PR contents but may perform only the issue/Roadmap reconciliation explicitly authorized by the canonical Verify contract.
- Deliver is the sole composite mode and uses one controller. Parent issues are outcome trackers, never branches or mega-PRs.
- One PR-sized issue owns one focused delivery PR. Canonical documentation changes belong to a linked Falryn Docs companion PR in the same delivery bundle—not the same cross-repository PR.
- Manual Merge follows the canonical full-bundle preview and confirmation contract. Deliver carries authorization only for its freshly verified resolved bundle.
- Next runs the repository-owned live Roadmap audit or replays a snapshot through that same auditor. It never manually recreates ranking and never mutates state.
- Re-read live GitHub state before every mutation. Automation, Project fields, issue text, activity, and green CI do not substitute for current source, documentation, and evidence.

## Reporting

Use [reporting](references/reporting.md). Name the exact target, revisions, state changes, validation, blockers, and limitations. Finish a completed mode or orientation response with one copy-ready `Suggested next prompt:` from fresh state; it is navigation, not authorization. A running Parent chain continues instead of stopping for a prompt while eligible siblings remain.

## Distribution

Keep this Falryn-specific bundle byte-identical between `~/.agents/skills/falryn-workflow/` and `falryn/.agents/skills/falryn-workflow/`. It is the sole repository-dependent bundle; all six other vendored skills remain portable.
