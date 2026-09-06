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
| `Docs PR #N` | `tyldra-org/falryn-docs` pull request N; resolve its docs-only or companion role |
| `Falryn Roadmap` | `tyldra-org` Project 1 through [Next](next.md) |
| Full GitHub URL | The exact host, repository, and object in that URL |

Never substitute a same-numbered object from the other repository. A companion link expands a delivery bundle only after the primary target is resolved and the reciprocal link, delivery owner, and current revision agree.

For issue or PR work, inspect native hierarchy, blockers, and closing PRs needed
by the operation. For Roadmap work, also resolve milestone, assignee, and exact
Project membership through authenticated authority. Public inspection must not
require private metadata. Never reconstruct hierarchy or dependencies from body
prose when native relationships exist.

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

## Suggest the next action

Resolve the suggested object through [delivery target resolution](#resolve-a-delivery-target).
Prefer the existing PR selector when continuing that PR, the issue selector
when selecting work without an active PR, and the docs-qualified form for a
docs-owned target. The input object does not select a manual stage. Resume a valid
interrupted chain with its exact parent-chain selector. For a new chain, prefer
`Deliver - Target: Parent chain #N` when the user's requested scope is that
parent outcome, or a broad Roadmap request and the audit establish a coherent
remaining child sequence owned by the authenticated account. Do not widen an
explicit single-issue request into a chain. A parent link alone is not enough:
verify the native hierarchy, remaining scope, ownership, and ordering first.
Use that child's issue or existing PR form when only its delivery is established.

Choose one useful next action from the user's goal, current evidence, and
remaining work. Prefer Deliver when the intended next outcome is complete
delivery. An existing PR, review findings, pending checks, or a PR ready to merge
can remain in the same controller; its current stage alone does not require a
manual prompt.

Recommend a manual mode when its bounded result is the better next action,
even if Deliver could perform that stage. For example, Plan can establish scope
before committing to implementation, Review can provide an independent
assessment, Verify can establish completion without making repairs, and Merge
can land an already verified bundle. Implement fits a request to prepare a PR
without merging. Honor explicit stage control and explain the concrete reason
for a manual suggestion. Do not manufacture a checkpoint for routine progress.

Do not use a manual mode to bypass missing authority, another owner, an
unresolved decision, or a failed audit. Those remain prerequisites. Suggest no
action when the requested outcome is complete and no useful continuation is
established. Output one selected prompt, not a menu of automatic and manual
alternatives, unless the user asks for options.

A suggested prompt never starts delivery. A new chain suggestion
offers that scope for the user to invoke and does not itself authorize any
child's implementation or merge.

Derive the suggestion from fresh evidence for the current scope. Public work
may suggest continuation of its exact issue or PR without private Roadmap
access. Selecting new Roadmap work or a parent sequence requires Next and its
audits. Do not audit the entire Roadmap just to continue a known public PR.
When no safe action is established, report `Suggested next prompt: none` and
the missing prerequisite.

## Mode boundaries

| Mode | Permitted result | Does not authorize |
| --- | --- | --- |
| Plan | Complete the resolved issue contract and, for Roadmap-owned work, reconcile planning metadata | Source or docs implementation, implementation branch, In Progress, merge |
| Implement | Deliver one complete, unblocked PR-sized issue to a PR in its repository; require Ready and assignment only when Roadmap-owned | Parent implementation, approval, merge |
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

Re-resolve affected facts after a head, base, issue contract, hierarchy, blocker,
assignee, milestone, Project field, companion, check, review, ruleset, default
branch, mergeability, or relevant checkout change. Refresh the affected review,
verification, and authoritative sequence before relying on them.

Keep authorization separate from evidence. A revision-specific manual merge
preview becomes stale when its preconditions change. An authorized Deliver
request still covers in-scope repair, but the changed candidate requires fresh
review, verification, and merge preflight. A normal check transition or completed
companion requires reconciliation, not a new user request. Changed ownership,
additional outcomes, or a wider bundle must be resolved against the user's
actual authorization before proceeding.

Stop on an ambiguous natural-language selector, a missing object, cross-repository identity mismatch, unsupported target for the selected mode, or conflict between public and private authorities. Ask one focused question only when the ambiguity changes the repository, object, or authorized mutation.
