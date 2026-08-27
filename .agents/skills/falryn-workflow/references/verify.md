# Verify

Read the Verify section of the canonical Development contract before acting.
Verification is a fresh, read-only audit; do not silently repair missing
behavior or broaden scope.

Review is complementary, not a synonym: use [Review](review.md) when the user
asks for an exact file/diff inventory, code-review findings, and blast-radius
assessment. Verify establishes delivery readiness against the issue and
complete bundle.

Choose the scope the target names:

- **Delivery PR:** audit the complete PR: its issue, full diff, delivery owner,
  checks, review findings, documentation impact, and merge readiness. Preview
  its exact squash subject and optional footer, plus safe post-merge checkout
  synchronization.
- **PR-sized issue, parent, milestone, or range:** compare the actual
  implementation against the selected acceptance scope, including required
  children, integration, recovery, security, resource, projection,
  documentation, and release criteria as applicable.

Record an implementation gap in its right owner. Code fixes require an explicit
Implement request, except within Deliver's correction loop. A passing Verify
may suggest Merge but never authorizes it.

Read [Corrections](corrections.md) for an observed gap, and
[Reporting](reporting.md) for the next prompt.
