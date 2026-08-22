# Verify

Read the Verify section of the canonical Development contract before acting.
Verification is a fresh, read-only audit; do not silently repair missing
behavior or broaden scope.

Review is complementary, not a synonym: use [Review](review.md) when the user
asks for an exact file/diff inventory, code-review findings, and blast-radius
assessment. Verify establishes delivery readiness against the issue and
complete bundle.

Choose the scope the target names:

- **Delivery PR:** audit the Falryn PR and every explicit companion docs issue
  and PR: complete diffs, delivery owner, checks, review findings, docs impact,
  cross-links, and merge readiness. Preview docs-first/application-last order,
  each exact squash subject and optional footer, and safe post-merge checkout
  synchronization.
- **Docs PR:** audit that docs PR, its issue, current product claims, checks,
  review findings, merge readiness, final squash subject, and safe docs
  checkout synchronization.
- **PR-sized issue, parent, milestone, or range:** compare the actual
  implementation against the selected acceptance scope, including required
  children, integration, recovery, security, resource, projection,
  documentation, and release criteria as applicable.

Record an implementation gap in its right owner. Code fixes require an explicit
Implement request, except within Deliver's correction loop. A passing Verify
may suggest Merge but never authorizes it.

Read [Corrections](corrections.md) for an observed gap, and
[Reporting](reporting.md) for the next prompt.
