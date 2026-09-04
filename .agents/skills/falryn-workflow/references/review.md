# Review

Review is a read-only assessment of one exact Falryn or, with private access, Falryn Docs pull-request revision. Load `change-review`, `gh-cli`, and the relevant available stack skill.

## Evidence

Resolve the repository, base and head SHA, author, public delivery issue, checks, reviews, merge state, and complete current diff. Inventory every added, modified, deleted, and renamed file. Read affected behavior, callers, data and wire formats, configuration, persistence, projections, and cleanup paths rather than reviewing filenames alone.

Compare the change with its public issue contract, current source, tests, and `CURRENT-STATE.md`. Apply [documentation delivery](documentation-delivery.md) when private docs access exists, adding exact owner and companion evidence without copying private content into the public report. Without access, classify documentation verification as unavailable rather than pretending it is unaffected.

Trace the central safety condition and concrete failure paths. Findings identify severity, path and line, impact, likelihood, and the cheapest disproving check. Separate actionable defects from cleared risks and unavailable evidence.

Observed CI and existing tests are evidence, not proof of every behavior. Never execute an untrusted pull-request head in a privileged maintainer checkout.

## Boundaries

Review never edits source, comments, approves, merges, changes labels or Project fields, or starts delivery. It does not establish complete bundle merge readiness; Verify owns that decision.

Report the exact revision, inventory, changed behavior, findings, safety condition, evidence level, cleared risks, documentation-access state, observed checks, and next safe prompt.
