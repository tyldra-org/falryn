# Resolve the work

A target identifies the outcome. The command determines the permitted actions.
Use the current repository object and native relationships, not remembered issue
numbers or body prose, to resolve ownership.

| Target spelling | Object |
| --- | --- |
| `Issue #N`, `PR #N` | `tyldra-org/falryn` issue or PR |
| `Docs issue #N`, `Docs PR #N` | `tyldra-org/falryn-docs` issue or PR |
| `Parent issue #N`, `Docs parent issue #N` | Parent in the respective repository |
| `Parent chain #N`, `Docs parent chain #N` | Explicit remaining child-delivery scope |
| Full GitHub URL | Exact host, repository and object in that URL |
| `Idea "description"` | A proposed outcome whose owner is not yet known; Plan only |
| `Falryn Roadmap`, `Target release "milestone title"` or an exact range | Selection or assessment through falryn-roadmap |

`Milestone "title"` is another spelling of `Target release "title"`, including in
a `… through "title"` range.

Never substitute the same number from the other repository. For a PR, resolve
its owning issue and actual closing relationship. Approved issue-free maintenance
such as Dependabot stays PR-owned. Missing ownership on an issue-required PR
needs resolution, not an invented issue or duplicate PR.

An issue may already have a delivery PR. Reuse it when its scope and branch remain
valid. Multiple competing delivery PRs require resolving the real owner before
acting. A docs PR can be docs-only or an application companion; establish its
role and reciprocal links through [documentation](documentation.md).

## Apply the command boundary

Plan can establish a leaf contract or decompose a parent. Implement accepts a
leaf or selects one ordered parent child and stops at its PR. Review accepts a
PR. Verify assesses the named issue, parent, PR, release or range itself. Merge
accepts the verified delivery bundle. Deliver accepts an issue, PR, one parent
child or an explicit parent chain. Resolve unsupported combinations before acting.

Plan with an `Idea` target resolves its owner through [issue contracts](issues.md):
update the existing issue or parent that owns the outcome, and create an issue
only when none does. By default it returns the complete draft of every issue and
Docs change without mutating anything, and stops. A request that says to apply,
such as "Apply this draft", authorizes those changes in the same run. A draft the
user supplies is input to check against source and open issues and to complete,
not text to copy. Other commands do not accept `Idea`; plan it into an issue first.

`Deliver - Target: Parent issue #N` covers one child. A parent chain covers its
remaining children, delivered serially under [work](work.md#parent-outcomes).
A Roadmap or release target is not a bulk-delivery instruction. Select one unit
or resolve an explicit bounded scope first.

Application delivery includes required docs companions when they belong to the
authorized outcome. A request limited to one docs companion covers that member,
not the remaining application merge. Inspect the related application as evidence
without acquiring permission to change or merge it.

## Preserve intent across messages

A status question during delivery does not cancel delivery. A correction changes
the affected facts. An explicit narrower stopping point limits subsequent work.
After interruption, inspect actual branches, PRs and effects before resuming.
Approving a draft shown earlier ("apply the draft") authorizes exactly that draft.
Re-read the affected records first, and show a material change before applying it.

A broad Next request selects across the current Roadmap. An earlier discussion
of a blocked issue does not turn it into a dependency-chain request. Conversely,
"continue that delivery" retains the established target. When the distinction
cannot be resolved and changes the work, ask one focused question.
