# Implement

Implement prepares one complete PR-sized issue as a PR in its owning repository.
Manual Implement stops there. Deliver continues after that boundary.

## Admit implementation

Apply [issue governance](issue-governance.md#admit-implementation) to the current
issue, source baseline, native relationships and existing delivery PRs. Resolve
[documentation impact](documentation-delivery.md) and the required authority.
A parent routes to one ordered child through [parent delivery](parent-delivery.md).

For Roadmap-owned work, require the authenticated account as sole assignee,
Ready and no open blockers; set In Progress as implementation begins. An issue
outside the Project requires its complete public handoff and authorization for
the checkout or fork, without private assignment or readiness requirements.

Reuse a valid delivery branch and PR. Otherwise branch from the fetched current
default branch under `git-workflow`. Use [recovery](deliver.md#recover-from-observed-state)
for closed or merged predecessors.

## Prepare the complete PR

Implement the issue through its real consumer. Update source and tests together;
change `CURRENT-STATE.md` only for source-verified behavior. Use focused checks
while iterating and the full repository validation before review. Apply
[execution rules](execution.md) to changed evidence or a failed check.

A docs-only issue changes its canonical documentation owners and runs Falryn Docs
validation. It owns a docs PR, without an artificial application issue or source
change. An application issue with private impact uses a verified docs companion
under [documentation delivery](documentation-delivery.md).

Commit and push intended changes, then create or update one focused PR using
the repository template. Record its exact owner, completed scope, validation,
documentation classification, verified companions, risks and unavailable proof.
Use a closing reference only for acceptance the PR fully completes. An unavailable
required companion prevents complete delivery; preparation that is permitted by
the repository may be reported as partial without claiming merge readiness.

After governance changes, run the required [audits](governance-audits.md).
Report the resulting PR and its evidence through
[mode reporting](targets-and-transitions.md#report-the-result).
