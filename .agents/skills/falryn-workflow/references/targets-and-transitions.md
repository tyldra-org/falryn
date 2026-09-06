# Targets and transitions

Resolve the user's target before loading a mode guide or touching GitHub. A mode selector changes the permitted workflow. It does not broaden the named target.

## Activate a mode

Recognize `Plan`, `Implement`, `Review`, `Verify`, `Merge`, `Deliver`, and `Next` when the user supplies the named selector or an unmistakable natural-language request for that operation. ASCII and typographic dashes are equivalent separators.

An ordinary Falryn request without one of those meanings remains an ordinary task. Load the repository and domain skills it needs, preserve normal authorization boundaries, and do not add Project transitions, automatic delivery, merge permission, or a mandatory suggested-next-prompt report.

## Resolve repository ownership

| Selector | Repository and object |
| --- | --- |
| `Issue #N` | `tyldra-org/falryn` issue N |
| `Parent issue #N` | `tyldra-org/falryn` parent issue N |
| `Parent chain #N` | Remaining ordered children of `tyldra-org/falryn` parent N |
| `PR #N` | `tyldra-org/falryn` pull request N and its explicitly linked companions |
| `Milestone "title"` or an exact milestone range | `tyldra-org/falryn` milestone scope |
| `Docs issue #N` | `tyldra-org/falryn-docs` docs-only issue N |
| `Docs parent issue #N` | `tyldra-org/falryn-docs` docs-only parent N |
| `Docs parent chain #N` | Remaining ordered children of the docs-only parent N |
| `Docs PR #N` | `tyldra-org/falryn-docs` docs-only pull request N |
| `Falryn Roadmap` | `tyldra-org` Project 1 through [Next](next.md) |
| Full GitHub URL | The exact host, repository, and object in that URL |

Never substitute a same-numbered object from the other repository. A companion link expands a delivery bundle only after the primary target is resolved and the reciprocal link, delivery owner, and current revision agree.

After resolution, inspect native `parent`, `subIssues`, `blockedBy`, `blocking`, closing pull requests, milestone, assignee, and Project membership. Do not reconstruct hierarchy or dependencies from body prose when native relationships exist.

## Resolve a delivery target

Keep the requested operation, repository/object, authorized scope, and current
delivery state separate. An issue or PR identifies work; it does not choose a
manual workflow stage. Resolve these facts once before entering Deliver:

| Input to Deliver | Resolved work |
| --- | --- |
| `Issue #N` or `Docs issue #N` | That repository's leaf issue and its existing delivery PR, if any |
| `PR #N` | That exact Falryn PR, its owning issue, and verified required companions |
| `Docs PR #N` | That exact docs PR and its docs-only owner, or its verified role in an application delivery |
| `Parent issue #N` or `Docs parent issue #N` | One next ordered child of that parent |
| `Parent chain #N` or `Docs parent chain #N` | The remaining ordered child deliveries within that parent |
| Exact GitHub issue/PR URL | The corresponding repository-qualified object above |

For a PR input, resolve its actual owner from the closing relationship and
current contract. Reuse the existing PR rather than starting a replacement
because the user entered through a different object. Keep a repository-approved
issue-free maintenance PR, such as Dependabot, PR-owned; do not invent a dummy
issue. A missing or conflicting owner on an issue-required PR is a resolution
gap, not permission to guess.

A docs companion is not a separate docs-only outcome. If a request is limited
to that companion, deliver only that authorized member and report the remaining
application delivery. Suggest the resolved application Deliver target when the
user wants the whole outcome; do not silently acquire authority to merge it.

Milestones, ranges, and Roadmap targets are selection or assessment scopes,
not new bulk Deliver controllers. Use the authoritative sequence to recommend
an existing issue, PR, or parent selector within the requested scope. Missing
scope, owner, authority, or sequence evidence requires resolution, not an
invented selector or a fallback manual prompt.

## Mode boundaries

| Mode | Permitted result | Does not authorize |
| --- | --- | --- |
| Plan | Complete a public issue contract and, with private authority, reconcile planning metadata | Source edits, implementation branch, In Progress, merge |
| Implement | Deliver one publicly complete, unblocked PR-sized issue to an open pull request; require Ready and assignment only when Roadmap-owned | Parent implementation, approval, merge |
| Review | Assess one exact pull-request revision | Comments, approval, edits, Project mutation, merge |
| Verify | Audit an exact PR, issue, parent, milestone, or range; perform only named governance reconciliation | Product or documentation repair, merge, release |
| Merge | Merge the unchanged bundle from a fresh Verify preview and reconcile it | Changed revisions, release publication, branch deletion |
| Deliver | Resolve the named issue, PR, docs, or parent scope and complete its remaining planning, implementation, review, verification, correction, merge, and reconciliation | Unrelated work, stale revision evidence, unlimited retries |
| Next | Read and route from one valid private Roadmap generation | Any mutation or automatic start of the suggested mode |

Plan, Implement, Review, Verify, and Merge remain separate manual modes. Review and Verify do not imply Merge. Deliver is the only composite mode, and its original request binds merge authority to the exact delivery owner and verified revisions.

## State ownership

- Public issue body: contribution and implementation handoff.
- Native issue relationships: hierarchy and blockers.
- Private Roadmap: Status, Priority, Readiness, liveness, and sequence.
- Source, tests, builds, and `CURRENT-STATE.md`: implemented behavior.
- Falryn Docs: canonical product and documentation contracts.
- Pull requests and checks: changed revision and delivery evidence.

One owner never substitutes for another. A checked Contribution or Ready list cannot override an open blocker. A Project field cannot fill an incomplete public handoff. Green CI cannot prove a different revision or missing documentation owner.

## Invalidation

Re-resolve the target and repeat the affected review or verification after any change to a head SHA, base, issue body, hierarchy, blocker, assignee, milestone, Project field, companion identity, check, review, ruleset, mergeability result, default branch, or relevant checkout state. Never carry merge authorization or a Roadmap sequence across one of those changes.

Stop on an ambiguous natural-language selector, a missing object, cross-repository identity mismatch, unsupported target for the selected mode, or conflict between public and private authorities. Ask one focused question only when the ambiguity changes the repository, object, or authorized mutation.
