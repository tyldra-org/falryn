---
name: falryn-workflow
description: Falryn-specific source, issue, pull-request, documentation, and Roadmap workflow for public-only and authenticated maintainer work across Falryn and Falryn Docs. Use for Falryn mode prompts, project orientation, delivery, or workflow maintenance; never for unrelated repositories.
---

# Falryn workflow

This bundle is the complete executable workflow for agents operating in the public Falryn checkout. It does not require a Falryn Docs checkout or private Roadmap access for public source, issue, and pull-request inspection.

It was last reconciled on 2026-09-03 against the public and private repository contracts, the live GitHub issue and Project model, GitHub CLI 2.100.0, and the repository-owned governance auditors. Treat that as a maintenance marker. Live repository guidance, source, GitHub state, installed CLI help, and verified private authority remain authoritative.

Falryn Docs and the Roadmap remain private maintainer authorities. Read [private authority](references/private-authority.md) before any operation that needs documentation ownership, Project fields, exact delivery sequencing, a docs-only target, or a cross-repository delivery bundle. Missing private access is an `unavailable` result, never permission to guess or disclose private state.

A Falryn greeting, walkthrough, status question, or "what next?" request routes through [Next](references/next.md).

## Request classification

Load this skill for Falryn work, but activate a maintainer mode only when the user supplies its selector or an unmistakable natural-language equivalent. An ordinary unprefixed request follows normal task semantics plus repository guidance and the relevant stack, Git, GitHub, or review skill. It does not silently become Plan, Deliver, Merge, Next, or a Roadmap mutation. Read [targets and transitions](references/targets-and-transitions.md) whenever the target or mode boundary is not already exact.

## Before acting

1. Resolve the exact repository and target. Never substitute a same-numbered object from another repository.
2. Read public `DEVELOPMENT.md`, source, tests, `CURRENT-STATE.md`, repository guidance, and the target's public issue or pull-request evidence.
3. Classify private authority as available or unavailable using [private authority](references/private-authority.md). Do not request, print, or persist credentials.
4. Load `gh-cli` for GitHub, `git-workflow` for Git mutations, `change-review` for review reasoning, and the relevant available stack skill.
5. Read [issue governance](references/issue-governance.md) before issue mutation, implementation, or routing.
6. Read [Roadmap fields and automation](references/roadmap-fields.md) before changing Priority, Readiness, Project workflows, issue forms, or governance automation.
7. Use [governance audits](references/governance-audits.md) for readiness, Project, liveness, or sequence claims. Use [documentation delivery](references/documentation-delivery.md) for documentation impact or a companion pull request.
8. Stop on an incomplete public implementation contract, unresolved authority, stale revision evidence, conflicting ownership, or a private-only operation without private access.

## Route one mode

| Request | Local owner |
| --- | --- |
| Target parsing, repository selection, mode activation, or state transition | [Targets and transitions](references/targets-and-transitions.md) |
| `Plan - Target: ...` | [Plan](references/plan.md) |
| `Implement - Target: ...` | [Implement](references/implement.md) |
| `Review - Target: PR #N` | [Review](references/review.md) |
| `Verify - Target: ...` | [Verify](references/verify.md) |
| `Merge - Target: ...` | [Merge](references/merge.md) |
| `Deliver - Target: Issue #N` | [Deliver](references/deliver.md) |
| `Deliver - Target: Parent issue #N` or `Parent chain #N` | [Deliver](references/deliver.md) and [Parent delivery](references/parent-delivery.md) |
| `Next - Target: Falryn Roadmap`, orientation, or status | [Next](references/next.md) |
| Verify gap or incomplete merged delivery | [Corrections](references/corrections.md) |
| Issue-readiness, Roadmap, liveness, or sequencing audit | [Governance audits](references/governance-audits.md) |
| Priority, Readiness, or Project automation maintenance | [Roadmap fields and automation](references/roadmap-fields.md) |
| Documentation impact, owner lookup, or companion delivery | [Documentation delivery](references/documentation-delivery.md) |

The ASCII hyphen forms above and the corresponding typographic-dash forms are equivalent selectors.

## Access boundary

Public-only operation supports inspection and preparation around an explicitly named public Falryn issue or pull request when its public evidence is complete. It does not establish private Project readiness, exact Roadmap order, private documentation completeness, or a docs companion.

Authenticated maintainer operation adds the verified private Falryn Docs and Roadmap authorities. Only that profile may run Next, parent-chain routing, docs-only modes, Project reconciliation, or a cross-repository docs-first merge bundle.

Ordinary contributors and forks do not need these maintainer modes. They follow public `DEVELOPMENT.md`, `CONTRIBUTING.md`, the issue body, source, and repository checks.

Private Project membership is an explicit maintainer decision to adopt an issue into Falryn product development. A public contribution issue or pull request does not require an assignee, milestone, Project item, Priority, Readiness, or knowledge of the private Roadmap. Never make those private fields a public contribution gate.

## Non-negotiable boundaries

- Plan, Implement, Review, Verify, and Merge are separate manual modes. Review and Verify never authorize Merge.
- Deliver is the sole composite mode. Parent issues are outcome trackers, never branches or mega-pull requests.
- One PR-sized issue owns one focused application PR. A private docs companion exists only when an authenticated maintainer verifies that documentation must change.
- Roadmap governance applies only to issues deliberately present in the private Project. Repository issues outside it remain valid contribution or discussion records and never enter private routing by inference.
- No public issue may depend on private documentation for an implementation requirement. Before Ready, its public body must contain the complete issue-specific handoff.
- Private content, snapshots, paths, Project fields, and credentials never enter public source, issues, pull requests, logs, artifacts, or reports merely because an agent could access them.
- Re-read live GitHub state before every mutation. Activity, green CI, issue prose, and cached state do not substitute for current evidence.
- Never publish private issue bodies, document text, Project fields, snapshots, or local private-checkout paths. Report only the minimum delivery classification needed by the public action.

## Reporting

Use [reporting](references/reporting.md). Name exact targets, revisions, access profile, state changes, validation, blockers, and limitations. A completed mode or orientation ends with one copy-ready `Suggested next prompt:` from fresh authoritative state. A suggestion is navigation, not authorization.

## Distribution

The bundle committed at `falryn/.agents/skills/falryn-workflow/` is authoritative.
Falryn Docs agents resolve it from a verified sibling checkout and may use an
installed global copy only as a fallback. Public Falryn work must not depend on
either a global installation or the private docs checkout. The five other
vendored skills remain portable. When maintaining the optional global copy,
change and validate the vendored bundle first, then require exact file parity.
