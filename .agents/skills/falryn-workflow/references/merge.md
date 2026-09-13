# Merge

Merge needs a fresh passing [Verify preview](assessment.md#verify) and user
authorization covering the exact delivery. An explicit Merge request covering
that preview or the originating in-scope Deliver request supplies authority.
Do not request the same permission again. If authority is missing, finish the
reviewable preview before asking. Load `gh-cli` for remote effects and
`git-workflow` for local synchronization.

## Recheck before each merge

Re-read the PR's head and base, checks, reviews and threads, rulesets,
mergeability, settings, default branch, companion identities, merge order,
message and relevant local checkout. Verify required private access. When a
precondition changed, refresh the affected assessment before mutation; in-scope
Deliver work remains authorized. An expanded bundle or changed owner needs
resolution against the user's actual scope.

An issue outside the Roadmap has no private Project prerequisite. Required or
unresolved private documentation impact still prevents complete merge readiness.

## Merge the bundle

Squash-merge required docs companions at their reviewed heads first. Verify each
result, refresh application preflight after companion settlement, and merge the
application last. A docs-only delivery merges its own PR; a request scoped to a
companion stops after that member.

Use the reviewed PR title as the squash subject. Keep the body empty unless the
preview includes one useful short issue-reference footer. Do not copy PR prose,
checks, risks or incremental commit messages into the squash message.

The bundle is sequential, not atomic. On an unexpected or uncertain result,
inspect what landed and report the partial state before another effect. Never
continue with a stale or failing application merely because its docs merged.

## Reconcile

Verify merge SHAs, issue closures and acceptance. Repair authorized governance
state without claiming incomplete work Done. For Roadmap members, reconcile
Project and parent state and run the required [audits](governance-audits.md).
Verify the final documentation result and any changed `CURRENT-STATE.md` claims.

Safely synchronize eligible clean local default checkouts through
`git-workflow`. Leave dirty, detached, divergent, conflicted or branch-locked
checkouts untouched and report them. Branch deletion and release publication
remain separate actions. Report resulting SHAs and recovery through a new revert
PR under [mode reporting](targets-and-transitions.md#report-the-result).
