# Work on the outcome

Use this guide within the command's stopping point. Deliver owns the whole
outcome; manual commands perform only their authorized portion. Keep a compact
working record in the conversation: scope, owner, revisions, completed proof,
observed effects and remaining work. Do not create another tracker or controller.

## Establish the contract

Read the owning issue, native blockers and hierarchy, existing PRs, and the
relevant source and tests. The handoff must explain its baseline, remaining
acceptance, non-goals, boundaries, applicable failure and recovery behavior,
resource limits, real consumers, validation and documentation impact.

Public Falryn issues must be implementable without private documents. For private
docs work, use its canonical owners and source evidence. Resolve conflicting
contracts at their owners. Split independently reviewable work into native
children rather than hiding it in a large checklist or PR.

Plan may repair derivable contract facts and planning records. A human-owned
choice must be named; do not guess it. An open prerequisite prevents dependent
implementation. Preserve the outcome, identify what is missing and resolve only
prerequisite work covered by the user's scope. Do not downgrade acceptance to
make a task appear deliverable.

Implementation requires an open, complete, unblocked PR-sized leaf and its current,
fully checked repository checklist. Public PR checks accept the public form's
Contribution checklist or the maintainer form's Ready checklist. Deliberately
adopted Roadmap work additionally requires the authenticated account as sole
assignee, Ready evidence and the [Roadmap contract](../../falryn-roadmap/references/governance.md).
Known Roadmap membership cannot be ignored when private access is lost.

## Continue from observed state

| What remains | Action |
| --- | --- |
| Contract gap | Plan the missing facts without starting implementation |
| Admitted acceptance not implemented | Use the existing valid branch/PR, or a fresh branch from current default |
| Candidate implementation | Review the complete diff and prove acceptance at its actual revision |
| Actionable defect | Repair the owning change when authorized, validate and reassess |
| Required checks pending | Observe CI and wait while doing independent useful work |
| Verified delivery with merge authority | Perform the merge preflight below |
| Already merged | Verify delivered acceptance and finish missing reconciliation |

Implement through the actual product or documentation consumer. Keep tests beside
the subject and update `CURRENT-STATE.md` only for verified behavior. Use the
repository PR template and one closing owner for a complete issue-sized outcome.
A separate private docs companion uses its public owner as a reference. Missing
private proof may permit PR preparation, but cannot establish merge readiness.

## Prove the result

Review uses `change-review` against the complete current diff, including callers,
contracts, state and failure paths. It reports findings without editing, posting
or approving. Verify compares actual evidence with every acceptance criterion
and the documentation obligation. Green CI or child closure alone is insufficient.
Neither command permits implementation repairs. Verify changes governance only
when the user separately authorized that reconciliation.

During implementation, run focused checks, then the full validation required by
`DEVELOPMENT.md` before review. Reuse results only when revision, dependencies,
configuration, toolchain, environment and scope still match. A new command or
stage alone is not a reason to repeat a successful check.

A new head or base requires review of the complete resulting diff and refreshed
verification. Contract or dependency changes refresh admission. Documentation
changes refresh affected owners. Live checks, reviews and merge conditions must
be read when relied on; cached conclusions cannot replace them. Do not execute
untrusted PR code in a privileged maintainer checkout.

Batch independent reads with stable inputs. Keep one writer per checkout,
dependent effects sequential and sibling delivery serial. Use the github-operations CI
waiter instead of busy polling. Do not create work merely to stay active.

## Merge and reconcile

A passing Verify preview identifies the exact PRs and base/head revisions,
acceptance evidence, docs disposition, checks and reviews, merge order, squash
subject/body, and eligible clean local default checkouts. Manual Merge needs
user authorization covering that preview. Deliver's originating request covers
its in-scope outcome at newly verified revisions. Do not ask again for authority
already granted, and do not treat an expanded bundle as automatically covered.

Before each merge, re-read head/base, required checks, reviews and threads,
rulesets, settings, mergeability, companions, message, authority and relevant
checkout state. Refresh changed evidence before mutating. Manual Merge cannot
repair source; Deliver may repair within scope and establish a new passing proof.

Squash-merge required docs companions at their reviewed heads first. Verify each
result, revalidate the application, then merge the application last. A docs-only
outcome merges its own PR. Use the reviewed PR title as subject and an empty body
unless the preview includes one useful short issue-reference footer.

Verify resulting commits and actual issue closure. Reconcile applicable Project,
parent and documentation state without declaring incomplete acceptance Done.
Run affected Roadmap audits. Safely synchronize eligible clean default checkouts
through git-operations; preserve dirty, detached, divergent or locked checkouts.
Report merge SHAs and recovery through a new revert PR. Branch deletion and
release publication need their own authority.

## Recover without losing the outcome

| Actual state | Recovery within authorized scope |
| --- | --- |
| Open PR has a gap | Keep the owner, branch, PR and valid companions; add focused commits |
| PR closed without merge | Reopen only if scope, branch, base and owner are still valid; otherwise replace it |
| Original acceptance incomplete after merge | Reopen the owner, correct stale completion and start a fresh branch from default |
| Distinct additional outcome | Create one focused follow-up owner instead of expanding completed work |
| Issue-free maintenance incomplete after merge | Establish a correction owner and fresh PR |
| External effect uncertain | Inspect resulting state before retrying |

Never reuse a squash-merged branch or edit a merged PR. Cross-repository merges
are not atomic: report exactly what landed and stop dependent effects on an
unexpected result. A merged companion does not justify a stale application merge.

Before a body or field mutation, retain its exact preimage, inspect the complete
candidate and re-read live state. Verify the effect before dependent work. Keep
private receipts outside public artifacts. After three repair attempts without
changed evidence, report the stalled condition and a different strategy.

## Parent outcomes

Use the audited order for one-child or explicit chain delivery. Check each child's
owner and admission. Needs Planning stays on that child; Needs Decision stops at
its named owner. Never start the next child while the current child's required
checks, merges and reconciliation are pending. Recompute order after settlement.

Plan and Verify retain the parent itself as their target. Parent planning keeps
Parent readiness and its valid Status. After the last required child, verify all
integrated behavior, failure, recovery, resource, security, documentation and
projection criteria before closure. An integration gap needs its own native child.
An explicit chain resumes at the first unsettled child, not from the beginning.
