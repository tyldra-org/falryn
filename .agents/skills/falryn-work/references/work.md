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
contracts at their owners. Size the work and complete any missing contract with
[issue contracts](issues.md) before writing code; a split discovered halfway
through implementation costs far more than one made up front.

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
| Open PR with pending checks, failures or review feedback | [Shepherd the pull request](#shepherd-the-pull-request) while doing independent useful work |
| Verified delivery with merge authority | Perform the merge preflight below |
| Already merged | Verify delivered acceptance and finish missing reconciliation |

Implement through the actual product or documentation consumer. Keep tests beside
the subject and update `CURRENT-STATE.md` only for verified behavior. Use the
repository PR template and one closing owner for a complete issue-sized outcome.
A separate private docs companion uses its public owner as a reference. Missing
private proof may permit PR preparation, but cannot establish merge readiness.

## Prove the result

Implement and Deliver include review and acceptance verification without separate
user prompts. Implement completes this check against the current PR candidate,
repairs in-scope gaps and stops with the prepared PR before merge. Deliver also
verifies landing and reconciliation. Neither needs an extra prompt asking whether
anything was missed during implementation.

Use `change-review` for the complete current diff and the engineering skills for
proof through real consumers. Manual Review remains read-only. Manual Verify
compares acceptance and documentation evidence without implementation repairs;
it changes governance only when that reconciliation was separately authorized.

Start the completion check from the original issue outcome, every acceptance
criterion and the applicable contracts, not just changed files, a PR checklist
or the implementation summary. Account for each promised result with its owning
implementation, actual product or documentation consumer and relevant evidence.
Inspect what could have been omitted as well as what changed. A helper that works
in isolation, a mocked integration, green CI, or a closed issue cannot by itself
prove the promised behavior reaches its consumer.

Before the first push, run that check as a pre-PR pass over the complete diff.
A gap found after CI costs a full CI cycle and often a second review:

- **Acceptance:** write down, in the working record, each outcome, behavior and
  completion-proof item with the implementation and test that satisfy it. An
  item missing either is not done, however complete the rest of the diff looks.
- **Tests:** each new test proves behavior through its consumer, is safe in the
  full suite and follows the test rules in `DEVELOPMENT.md`, including explicit
  timeouts for journeys through real product turns.
- **Defects and scope:** run `change-review` on the diff, including what static
  analysis flags, such as no-op operations and unused values. Split out
  unrelated work.

Repair what the pass finds before pushing.

For related changes within the selected outcome, check interacting contracts at
identified revisions. Implement uses the current PR candidate with its declared
base and dependency revisions. A related unmerged PR is neither assumed present
nor required to merge merely to perform this check. If acceptance depends on
unavailable work, report the prerequisite and unverified criterion. Integration
testing does not expand implementation or merge authority. Deliver refreshes
affected integration evidence against landed revisions after authorized merges.

Separate passing PRs do not prove that their combined behavior works. Follow
relevant dependencies and consumers without expanding into unrelated assigned
issues, sibling delivery or a repository-wide audit. Apply failure, lifecycle,
compatibility and documentation checks where the outcome requires them; the
engineering skills own the detailed method.

Distinguish missing original acceptance, insufficient verification and optional
additional work. Implement and Deliver repair known in-scope gaps, check the
correction and reassess affected acceptance before their respective stopping
points. Do not leave an authorized repair for a suggested next prompt or move
missing original acceptance into a follow-up issue while declaring the original
complete. A missing prerequisite,
human decision or unavailable required proof keeps the affected implementation or
delivery incomplete; name the gap and what resolves it. Use the recovery rules
below for acceptance discovered incomplete after merge.

During implementation, run focused checks. When the candidate is complete, they
pass and the pre-PR pass is clean, push it and open the pull request (and any
companion) as a draft, so CI runs while review proceeds. Mark it
ready only after its checks pass and review is complete. The complete suite is CI's
job; run it locally only where `DEVELOPMENT.md` requires it. A later repair gets
focused checks, and CI proves the new head. Reuse results only when
revision, dependencies, configuration, toolchain,
environment and scope still match. A new command or stage alone is not a reason
to repeat a successful check.

A new head or base requires review of the complete resulting diff and refreshed
verification. Contract or dependency changes refresh admission. Documentation
changes refresh affected owners. Live checks, reviews and merge conditions must
be read when relied on; cached conclusions cannot replace them. Do not execute
untrusted PR code in a privileged maintainer checkout.

Batch independent reads with stable inputs. Keep one writer per checkout,
dependent effects sequential and sibling delivery serial. Use the
github-operations CI waiter instead of busy polling. Do not create work merely
to stay active.

## Keep delivery fast

Speed comes from removing repeated and idle work, never from skipping proof.

- Read the issue, its owners and their tests once, in batched reads, and keep
  the findings in the working record instead of re-reading them.
- Iterate with focused tests. Run `bun run check` once on the complete
  candidate, plus the build and compiled smoke only where `DEVELOPMENT.md`
  requires them.
- Overlap waiting with writing. Start long local checks in the background when
  the candidate is complete, and write `CURRENT-STATE.md`, the docs companion
  and pull-request bodies while they run. While CI runs, prepare reconciliation.
- Run unattended commands non-interactively, with standard input closed, so a
  test can never wait on a terminal, and poll them with a bounded waiter.
- Group related edits to a file into one change and verify them with one diff.

## Shepherd the pull request

After opening a PR, keep it moving until it is ready to merge (Deliver) or ready
for review (Implement), or a blocker needs the user. Wait with the
github-operations CI waiter. On each wake, read review threads and comments,
then failing checks, then merge state, for the head SHA you act on.

- **Review feedback first.** A fix pushes a new head, which reruns CI anyway.
  Fix code-scanning and bot findings in code; the scanner closes its own thread,
  otherwise resolve it once the fix is on the head. Do not reply to or resolve a
  human's thread without the user's confirmation.
- **Classify each failed job from its failed log before acting.** A failure in
  code or tests the change touches, or in a test it added, is the change's to
  repair. The test runner already reran any registered known flake; a warning
  naming its issue needs nothing more than a note in the report. A failure in
  suites the change does not reach, one whose product code already passed on an
  earlier head, or runner and network trouble is unrelated: rerun the failed jobs
  once for that head. A test that then passes is a new flake. Record it with its
  decisive error in the PR's risks and the report, and recommend an owning issue
  and registry entry as their own change, not part of this PR. A required check
  that still fails is a merge blocker to report, not a reason to keep rerunning.
- **Blocked with green checks:** read the branch rules and fix the actual cause,
  such as an unresolved thread, a missing required check or the PR metadata
  check's body format. Never bypass rules or required checks.

Follow the `github-operations` CI guide for logs, reruns and repair limits.

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

Verify that the resulting commits contain the assessed changes and preserve the
acceptance and integration proof. Refresh evidence affected by landing before
the final completion report; reuse unchanged proof rather than repeating the
entire review or test suite. Verify actual issue closure. Reconcile applicable
Roadmap field, parent and documentation state without declaring incomplete acceptance Done.
Run the affected Roadmap audits once, after the last reconciliation mutation.
Safely synchronize eligible clean default checkouts
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
