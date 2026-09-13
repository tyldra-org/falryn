---
name: falryn-workflow
description: Run Falryn delivery modes, select the next Roadmap issue, orient users to the project, and maintain this workflow across Falryn and Falryn Docs.
---

# Falryn workflow

Resolve the request, load its guide, and carry it to its stated finish line.
This skill owns Falryn workflow decisions. Repository guidance owns validation;
`git-workflow` owns Git, `gh-cli` owns GitHub, and `change-review` owns review
reasoning. Load the relevant engineering and stack skills through `AGENTS.md`.

## Choose the operation

Recognize the named commands below and unmistakable natural-language equivalents.
Accept ASCII or typographic dashes. An ordinary edit or question stays an ordinary
task with its existing authorization. It does not start Deliver or acquire
Project mutations. Greetings, project walkthroughs, status and "what next?"
are read-only orientation through Next; answer the actual question as well.

Read `AGENTS.md`, `DEVELOPMENT.md`, and the named issue or PR. Reuse unchanged
instructions. For a mode, read [target resolution](references/targets-and-transitions.md)
and [execution rules](references/execution.md), then only the applicable guide:

| Operation | Guide | Finish line |
| --- | --- | --- |
| Plan | [Plan](references/plan.md) | Issue contract and applicable planning metadata; no implementation |
| Implement | [Implement](references/implement.md) | One complete issue prepared as a PR; no merge |
| Review | [Assessment: Review](references/assessment.md#review) | Read-only findings on one exact PR revision |
| Verify | [Assessment: Verify](references/assessment.md#verify) | Completion evidence or merge preview; only explicitly authorized governance reconciliation |
| Merge | [Merge](references/merge.md) | The verified, authorized bundle merged and reconciled |
| Deliver | [Deliver](references/deliver.md) | Remaining work through merge and reconciliation within the named scope |
| Next | [Next](references/next.md) | One recommendation from a valid Roadmap generation; no mutation or automatic start |

Manual modes stop at their finish line. Deliver composes them and continues
without asking the user to invoke each stage. The request supplies authority;
this skill never grants additional scope, posting, release or cleanup permission.

## Load conditional rules

| Condition | Owner |
| --- | --- |
| Issue creation, planning, or admission to implementation | [Issue governance](references/issue-governance.md) |
| Private Docs or Roadmap facts are needed | [Private authority](references/private-authority.md) |
| Documentation impact or companion PR | [Documentation delivery](references/documentation-delivery.md) |
| Readiness, liveness, ordering or Project reconciliation claim | [Governance audits](references/governance-audits.md) |
| Project fields, automation or governance contract change | [Roadmap fields](references/roadmap-fields.md) |
| Explicit parent or chain delivery | [Parent delivery](references/parent-delivery.md) |
| Closed, merged, incomplete or uncertain delivery | [Recovery](references/deliver.md#recover-from-observed-state) |

Source, tests, builds and `CURRENT-STATE.md` establish what is implemented.
The public issue owns the implementation handoff. Native relationships own
blockers and hierarchy. Private access adds only the facts and operations that
need it; public work must remain possible without that access.

## Maintain and distribute

This vendored bundle is authoritative. Falryn Docs uses an identity-verified
sibling Falryn checkout, with an installed global copy as fallback. Keep the
five other vendored skills portable and keep private records out of this bundle.

For workflow changes, use `skill-creator` and the global
`software-engineering-discipline`. Trace callers before moving references, keep
each decision in one owner, and exercise realistic requests across changed
boundaries. Run `python3 scripts/validate_skill.py` from this directory. It checks
structure, reachability, links and some public-content boundaries, not behavior.

Validate the vendored version before syncing an installed copy. Verify its
preimage, remove only known obsolete bundle files, preserve unrelated local
files, and check parity for the complete maintained bundle. Report local edits,
installation and remote delivery as separate results.
