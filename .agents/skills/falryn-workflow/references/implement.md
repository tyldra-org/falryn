# Implement

Implement accepts one explicitly named, complete, unblocked PR-sized issue in
its resolved repository. Falryn issues require a complete public handoff;
docs-only issues require Docs access and their repository contract. If the issue
is Roadmap-owned, it must also be Ready and assigned under the private maintainer
contract. A parent target routes through its selected child.

Apply [shared execution efficiency](execution-efficiency.md) within Implement's permissions. Reuse the current complete handoff and valid evidence without skipping validation or starting another mode.

## Preconditions

1. Read the complete issue handoff, repository guidance, native hierarchy, blockers, and existing delivery PRs. Read the affected source baseline, tests, and `CURRENT-STATE.md` for application behavior, or the canonical documentation owners and their source evidence for docs-only work.
2. Require the selected issue format's checklist to be checked and current: Contribution checklist for public submissions, Ready checklist for maintainer handoffs. An adopted public contribution may retain its original form; do not require a duplicate Contribution checklist on a maintainer handoff. Roadmap-owned delivery still requires the authenticated readiness audit. A private link cannot fill a missing public requirement.
3. For Roadmap-owned work, require authenticated Roadmap access, confirm the authenticated account is the sole assignee, verify Ready and unblocked state, then set In Progress before implementation.
4. A contribution issue outside the Roadmap needs no private access or private readiness claim. Implementation may proceed when its public handoff is complete and the user authorizes work in the current branch or a fork. Follow `CONTRIBUTING.md` and the public pull-request contract.
5. Reuse a valid open correction branch and PR only after fresh verification. Otherwise branch from the fetched current default branch.

## Execution

Implement the complete issue with the smallest coherent changes. For application
work, update source and tests together and change `CURRENT-STATE.md` only when
verified behavior changes. Run focused checks while iterating, then the
repository's required validation.

For docs-only work, implement the documentation outcome in its canonical owners
and use Falryn Docs validation. It owns its docs PR; do not create an application
issue, source edit, or companion merely to imitate application delivery.

Classify documentation impact through [documentation delivery](documentation-delivery.md) as:

- `private-update-required`;
- `private-verify-unaffected`;
- `private-verification-unavailable`;
- `public-code-adjacent-update`; or
- `not-applicable`.

A contributor without private docs access records the classification and evidence in the Falryn PR. An authenticated maintainer owns any required private docs companion. Do not copy private pages into Falryn or make up a companion link. After Roadmap readiness or Status changes, run the scopes required by [governance audits](governance-audits.md).

Commit and push only intended paths. Open or update one focused PR in the
resolved repository with its delivery owner, scope, validation, limitations,
documentation classification, and any verified companion identity. Manual
Implement stops at the PR. Inside Deliver, the controller continues through
review, verification, and merge under its existing authority.

## Stop conditions

Stop on an incomplete issue body, open blocker, ownership mismatch, stale base, conflicting public and private contracts, unavailable required docs companion, failed validation, uncertain external effect, or changed PR revision. Report the exact recovery action.
