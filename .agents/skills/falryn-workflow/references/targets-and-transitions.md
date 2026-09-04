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

## Mode boundaries

| Mode | Permitted result | Does not authorize |
| --- | --- | --- |
| Plan | Complete a public issue contract and, with private authority, reconcile planning metadata | Source edits, implementation branch, In Progress, merge |
| Implement | Deliver one Ready, unblocked, assigned PR-sized issue to an open pull request | Parent implementation, approval, merge |
| Review | Assess one exact pull-request revision | Comments, approval, edits, Project mutation, merge |
| Verify | Audit an exact PR, issue, parent, milestone, or range; perform only named governance reconciliation | Product or documentation repair, merge, release |
| Merge | Merge the unchanged bundle from a fresh Verify preview and reconcile it | Changed revisions, release publication, branch deletion |
| Deliver | Run the named issue's bounded Plan, Implement, Verify, correction, Merge, and reconciliation loop | Unrelated issues, changed heads, unlimited retries |
| Next | Read and route from one valid private Roadmap generation | Any mutation or automatic start of the suggested mode |

Plan, Implement, Review, Verify, and Merge remain separate manual modes. Review and Verify do not imply Merge. Deliver is the only composite mode, and its original request binds merge authority to the exact delivery owner and verified revisions.

## State ownership

- Public issue body: complete implementation handoff.
- Native issue relationships: hierarchy and blockers.
- Private Roadmap: Status, Priority, Readiness, liveness, and sequence.
- Source, tests, builds, and `CURRENT-STATE.md`: implemented behavior.
- Falryn Docs: canonical product and documentation contracts.
- Pull requests and checks: changed revision and delivery evidence.

One owner never substitutes for another. A checked Ready list cannot override an open blocker. A Project field cannot fill an incomplete public handoff. Green CI cannot prove a different revision or missing documentation owner.

## Invalidation

Re-resolve the target and repeat the affected review or verification after any change to a head SHA, base, issue body, hierarchy, blocker, assignee, milestone, Project field, companion identity, check, review, ruleset, mergeability result, default branch, or relevant checkout state. Never carry merge authorization or a Roadmap sequence across one of those changes.

Stop on an ambiguous natural-language selector, a missing object, cross-repository identity mismatch, unsupported target for the selected mode, or conflict between public and private authorities. Ask one focused question only when the ambiguity changes the repository, object, or authorized mutation.
