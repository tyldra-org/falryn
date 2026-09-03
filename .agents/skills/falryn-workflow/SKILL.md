---
name: falryn-workflow
description: Falryn-specific routing for optional Plan, Implement, Review, Verify, Merge, Deliver, and Next modes, plus read-only project orientation. Use only in Falryn or Falryn Docs work; all other skill bundles remain product-agnostic.
---

# Falryn workflow

This bundle is the complete executable workflow for agents operating in the public Falryn checkout. It does not require a Falryn Docs checkout or private Roadmap access for public source, issue, and pull-request inspection.

Falryn Docs and the Roadmap remain private maintainer authorities. Read [private authority](references/private-authority.md) before any operation that needs documentation ownership, Project fields, exact delivery sequencing, a docs-only target, or a cross-repository delivery bundle. Missing private access is an `unavailable` result, never permission to guess or disclose private state.

A Falryn greeting, walkthrough, status question, or "what next?" request routes through [Next](references/next.md).

## Before acting

1. Resolve the exact repository and target. Never substitute a same-numbered object from another repository.
2. Read public source, tests, `CURRENT-STATE.md`, repository guidance, and the target's public issue or pull-request evidence.
3. Classify private authority as available or unavailable using [private authority](references/private-authority.md). Do not request, print, or persist credentials.
4. Load `gh-cli` for GitHub, `git-workflow` for Git mutations, `change-review` for review reasoning, and the relevant available stack skill.
5. Read [issue governance](references/issue-governance.md) before issue mutation, implementation, or routing.
6. Stop on an incomplete public implementation contract, unresolved authority, stale revision evidence, conflicting ownership, or a private-only operation without private access.

## Route one mode

| Request | Local owner |
| --- | --- |
| `Plan - Target: ...` | [Plan](references/plan.md) |
| `Implement - Target: ...` | [Implement](references/implement.md) |
| `Review - Target: PR #N` | [Review](references/review.md) |
| `Verify - Target: ...` | [Verify](references/verify.md) |
| `Merge - Target: ...` | [Merge](references/merge.md) |
| `Deliver - Target: Issue #N` | [Deliver](references/deliver.md) |
| `Deliver - Target: Parent issue #N` or `Parent chain #N` | [Deliver](references/deliver.md) and [Parent delivery](references/parent-delivery.md) |
| `Next - Target: Falryn Roadmap`, orientation, or status | [Next](references/next.md) |
| Verify gap or incomplete merged delivery | [Corrections](references/corrections.md) |

The ASCII hyphen forms above and the corresponding typographic-dash forms are equivalent selectors.

## Access boundary

Public-only operation supports inspection and preparation around an explicitly named public Falryn issue or pull request when its public evidence is complete. It does not establish private Project readiness, exact Roadmap order, private documentation completeness, or a docs companion.

Authenticated maintainer operation adds the verified private Falryn Docs and Roadmap authorities. Only that profile may run Next, parent-chain routing, docs-only modes, Project reconciliation, or a cross-repository docs-first merge bundle.

Ordinary contributors and forks do not need these maintainer modes. They follow public `CONTRIBUTING.md`, the issue body, source, and repository checks.

## Non-negotiable boundaries

- Plan, Implement, Review, Verify, and Merge are separate manual modes. Review and Verify never authorize Merge.
- Deliver is the sole composite mode. Parent issues are outcome trackers, never branches or mega-pull requests.
- One PR-sized issue owns one focused application PR. A private docs companion exists only when an authenticated maintainer verifies that documentation must change.
- No public issue may depend on private documentation for an implementation requirement. Before Ready, its public body must contain the complete issue-specific handoff.
- Private content, snapshots, paths, Project fields, and credentials never enter public source, issues, pull requests, logs, artifacts, or reports merely because an agent could access them.
- Re-read live GitHub state before every mutation. Activity, green CI, issue prose, and cached state do not substitute for current evidence.

## Reporting

Use [reporting](references/reporting.md). Name exact targets, revisions, access profile, state changes, validation, blockers, and limitations. A completed mode or orientation ends with one copy-ready `Suggested next prompt:` from fresh authoritative state. A suggestion is navigation, not authorization.

## Distribution

Keep this Falryn-specific bundle byte-identical between the maintainer-global `falryn-workflow` directory and `falryn/.agents/skills/falryn-workflow/`. The five other vendored skills remain portable. `engineering-best-practices` is global-only and is not a Falryn distribution dependency.
