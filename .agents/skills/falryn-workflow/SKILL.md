---
name: falryn-workflow
description: Resolve and deliver Falryn issues, pull requests, and documentation; route maintainer Roadmap work and maintain the workflow. Use for Falryn mode prompts, orientation, or workflow changes across Falryn and Falryn Docs.
---

# Falryn workflow

This bundle owns the Falryn agent workflow. Public contributions use the public
checkout and its issue contract. Private Falryn Docs and Roadmap access add
maintainer capabilities only where the selected operation needs them.

## Start with the request

Resolve the repository, object, requested operation, and authorized scope.
Load [targets and transitions](references/targets-and-transitions.md) for mode
activation, selectors, continuation suggestions, and changes to those facts.
An ordinary request stays an ordinary task; it does not acquire Project
transitions, automatic delivery, or mode-specific reporting. Falryn greetings,
project walkthroughs, status questions, and "what next?" use read-only Next.

Read repository guidance, `DEVELOPMENT.md`, and the named issue or PR. Then read
only evidence relevant to the requested result. Source, tests, and
`CURRENT-STATE.md` establish implementation claims; a workflow wording edit
does not require rediscovering unrelated product code. Reuse already-read
instructions while their revision remains unchanged.

Load `gh-cli` for GitHub, `git-workflow` for Git mutations, `change-review` for
review, and the relevant stack skill when its subject is affected. Apply
[execution efficiency](references/execution-efficiency.md) once per unchanged
revision for named modes, including Deliver chains.

## Read the owner when needed

| Work | Reference |
| --- | --- |
| `Plan - Target: ...` | [Plan](references/plan.md) |
| `Implement - Target: ...` | [Implement](references/implement.md) |
| `Review - Target: PR #N` or `Docs PR #N` | [Review](references/review.md) |
| `Verify - Target: ...` | [Verify](references/verify.md) |
| `Merge - Target: ...` | [Merge](references/merge.md) |
| `Deliver` for an issue, PR, or docs-qualified target | [Target resolution](references/targets-and-transitions.md#resolve-a-delivery-target), then [Deliver](references/deliver.md) |
| `Deliver` for one child or a parent chain | Deliver plus [parent delivery](references/parent-delivery.md) |
| `Next - Target: Falryn Roadmap`, orientation, or status | [Next](references/next.md) |
| Verified gap, closed PR, or incomplete merged work | [Corrections](references/corrections.md) |
| Issue mutation or implementation admission | [Issue governance](references/issue-governance.md) |
| Private docs, Project, parent routing, or companion authority | [Private authority](references/private-authority.md) |
| Readiness, Project, liveness, or sequence claims | [Governance audits](references/governance-audits.md) |
| Priority, Readiness, Project workflows, forms, or governance automation changes | [Roadmap fields](references/roadmap-fields.md) |
| Documentation impact, canonical owners, or companions | [Documentation delivery](references/documentation-delivery.md) |

Follow links when their condition applies, not as a checklist to load the whole
bundle. Manual modes stop at their declared result. Deliver alone composes
planning through merge and reconciliation within its resolved scope.

## Admission and authority

An incomplete implementation contract prevents implementation. Plan, including
planning inside Deliver, may resolve derivable missing facts. Stop for a named
human decision, conflicting ownership, or an unavailable required authority.
Refresh stale evidence before relying on it.

Public contributions and approved issue-free maintenance PRs may complete under
explicit delivery authority when their public contract and documentation
result permit it. Private Project membership is deliberate maintainer adoption;
an issue outside the Project requires no private fields. Do not infer membership
from the `roadmap` formatting label or impose private access on ordinary work.

Resolve Docs and Roadmap access independently, only when needed. Next and parent
sequencing need authenticated Roadmap authority; docs-only work needs Docs
authority. Required unresolved private documentation impact prevents complete
delivery. Missing access is `unavailable`, never a guessed value or an unaffected
claim. Public issues must contain their complete implementation handoff.

Re-read affected live GitHub state before mutation. Keep private document text,
issue bodies, paths, Project fields, snapshots, credentials, and authenticated
API responses out of public artifacts. Share only the needed delivery facts.

## Reporting

Report observed results at the scale of the task: exact repository and target,
relevant revisions, authority used or unavailable, mutations and resulting state,
checks and outcomes, documentation classification, remaining risks, and recovery.
Distinguish merged, pending, failed, skipped, unavailable, and partial members.
For files the user can inspect, use clickable absolute local paths in chat;
include repository-qualified paths and durable links when public and useful.
Never commit machine-specific paths or private report content.

A completed mode or orientation ends with one copy-ready line, chosen through
[continuation routing](references/targets-and-transitions.md#suggest-the-next-action):

```text
Suggested next prompt: Deliver - Target: Issue #123
```

Use exact observed identities. If no safe action can be established, use
`Suggested next prompt: none` and name the prerequisite. Suggestions never
start work or grant authority. Ordinary tasks need no mode-specific footer.

## Distribution

`falryn/.agents/skills/falryn-workflow/` is authoritative. Falryn Docs resolves
it from an identity-verified sibling checkout, with an installed global copy
only as a fallback. Public work must not depend on either private Docs or a
global installation. Keep the other five vendored skills portable.

Run `python3 scripts/validate_skill.py` from this skill directory after edits.
It checks structure, reference reachability, local links, and public content
boundaries. Also review realistic routing and authority scenarios; structural
validation alone does not prove the workflow makes good decisions.

When maintaining the global copy, validate the vendored bundle first, preserve
unrelated local files, and require parity for all skill content. Live repository
guidance, source, GitHub state, installed CLI help, and verified private
contracts remain authoritative over remembered state.
