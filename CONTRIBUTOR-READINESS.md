# Contributor readiness

Falryn is currently limited to collaborators while the foundation changes
quickly. The repository is nevertheless prepared for external contributions:
required issue forms, PR context and size checks, changed-file area labels,
CODEOWNERS, security reporting, Dependabot, multi-platform CI, and the
issue-governance policy are already present.

## Opening contributions

When the contracts are stable, lift the GitHub interaction restriction for the
repository or organization. `main` is already protected with the safeguards
below; do not relax them at the same time:

1. keep `main` pull-request-only, linear, and protected from force pushes and
   deletion;
2. require every CI job in `.github/workflows/ci.yml` and the **Validate
   contribution metadata** check from `.github/workflows/pr-metadata.yml`;
3. require conversation resolution; and
4. after a second maintainer can review independently, require one approving
   review and CODEOWNERS review for protected paths. A sole maintainer must not
   enable a rule it cannot satisfy.

The one operational change is the interaction restriction. When a second
maintainer can review independently, an organization administrator enables the
already documented one-approval and CODEOWNERS-review requirements in the same
branch-protection rule.

## Enforcement scope

Repository rulesets and contribution-policy checks apply to every contributor
except the repository owner's exact GitHub account. That includes organization
members, collaborators, maintainers, and future external contributors. The
owner is the only `always` bypass actor on main, release branches, and release
tags; granting repository admin access to someone else does not grant the same
exception.

The owner exception preserves emergency and solo-maintenance access. Size, area,
and trust labels may still be applied as informational metadata, but they do not
block the owner.

## Triage contract

Every valid report is triaged into the Falryn Roadmap exactly once with one
owner, one milestone, one Status, one P0–P3 Priority, current Readiness, one
work-type label, at least one area label, and either a native parent or explicit
Standalone relationship. Priority expresses urgency; Readiness records whether
the current issue contract is executable without invention; native blockers
remain the hard dependency authority. A Standalone declaration uses the
whole-line issue-form value `Standalone` or the exact durable marker `Planning
relationship: Standalone-v1.` Descriptive, negated, legacy ownership, or
incidental prose does not count. The
`Issue governance` workflow reminds maintainers about
repository-owned assignee and label metadata; it never invents them.

The public checkout does not require Falryn Docs or Roadmap access. A public
issue must contain its complete implementation handoff before a maintainer marks
it Ready. Ordinary contributors validate source with the repository commands in
`CONTRIBUTING.md`; they do not need to run private governance audits.

Two repository-owned audits are maintainer controls. The issue-body audit checks
public Falryn handoffs against the private canonical-document tree. The Roadmap
audit checks private cross-repository Project membership, Status, Priority,
Readiness, linked-pull-request liveness, and exact delivery sequence. Their live
forms require authenticated access to the private companion repository and
Roadmap and are intentionally unavailable to a public-only checkout.

Maintainers use the authoritative command forms and required arguments in the
private companion's development contract, substituting only the verified local
checkout and snapshot paths. Tokens are never passed in argv. Snapshots contain issue bodies and
private Project metadata, remain local, and are never committed or copied into
public reports. Snapshot parsing rejects missing scope, invalid or future
observations, and contradictory state. Any diagnostic suppresses sequencing.

An agent without private authority reports that maintainer governance is
unavailable. It may still inspect, review, and verify an explicitly named public
Falryn issue or pull request. It never reconstructs private readiness or order
from issue numbers, labels, milestones, recency, or board-independent guesses.

An issue with an open blocker remains Todo. A leaf may have at most one open
closing pull request and is In Progress while it is open. A parent never owns a
closing pull request, becomes In
Progress when a child starts or closes, and remains there through integrated
verification after the final child closes. An open leaf may remain In Progress
without an open linked closing pull request for at most seven calendar days
after the Status transition. Closed issues retain recorded P0–P3 values; a
previously unset closed issue uses the non-ranking Historical value rather than
an invented past priority.

Pull requests link an issue, explain scope, validation, documentation impact,
and risk. Automation applies changed-file area labels, exactly one `size: *`
label, and a transparent `vouch: *` trust classification. A large PR is not
automatically rejected, but `size: XL` is a deliberate signal to split it when
the outcome can remain independently reviewable. The vouch list records only
maintainer decisions about trusted external authors; it does not grant merge
permission or bypass checks.
