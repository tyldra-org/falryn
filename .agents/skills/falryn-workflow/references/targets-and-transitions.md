# Targets and transitions

Resolve the operation, repository, object and authorized scope separately.
Neither an issue number nor the current PR stage changes the requested operation.
Ask only when an unresolved ambiguity changes the target or permitted action.

## Resolve repository ownership

| Selector | Meaning |
| --- | --- |
| `Issue #N`, `PR #N` | Exact issue or PR in `tyldra-org/falryn` |
| `Docs issue #N`, `Docs PR #N` | Exact issue or PR in `tyldra-org/falryn-docs` |
| `Parent issue #N`, `Docs parent issue #N` | That repository's parent outcome; the operation determines its scope |
| `Parent chain #N`, `Docs parent chain #N` | Remaining ordered child deliveries within that parent |
| `Falryn Roadmap` | `tyldra-org` Project 1 through Next |
| `Target release "title"` or an exact release range | Private Roadmap selection or assessment scope |
| Full GitHub URL | Exact host, repository and object in the URL |

Never substitute a same-numbered object from another repository. Resolve native
hierarchy, blockers and closing PRs for the operation. Read Project membership
and scheduling facts only when [private authority](private-authority.md) is
needed. The `roadmap` label selects a body format; it does not prove membership.

Plan accepts issue contracts, including parent decomposition. Implement accepts
one leaf or selects one child of a parent. Review accepts a PR. Verify assesses
the named PR, issue, parent, release or range itself. Merge accepts a verified
delivery bundle. Parent chains are Deliver scopes. Resolve an unsupported pairing
before acting; a recognized object does not activate another mode.

## Resolve a delivery target

An issue input resolves to its existing delivery PR when one exists. A PR input
resolves to its actual owner through the closing relationship and current
contract. Reuse that delivery regardless of the entry selector. Preserve an
approved issue-free maintenance PR, such as Dependabot, as PR-owned. Missing or
conflicting ownership on an issue-required PR is a gap to resolve, not a reason
to invent an issue or replacement PR.

In Deliver, an issue with native children routes through [parent delivery](parent-delivery.md).
An explicit chain authorizes its remaining child scope; a parent issue selects
one child. Plan and Verify retain the parent as their object. Roadmap and release
scopes select or assess work; they do not create a bulk Deliver mode. Use
[Next](next.md) to select a supported delivery target.

A docs PR may own a docs-only outcome or be an application companion. Verify
its role, delivery owner, reciprocal links and current revisions through
[documentation delivery](documentation-delivery.md). An application delivery
includes required companions within its authorized outcome. A request limited
to a companion covers only that member; it does not authorize application merge.

## Suggest the next action

Use the remaining user goal and fresh evidence to choose one useful action.

- Continue a known delivery with its existing PR selector, or its issue selector
  before a PR exists. Use `Docs` for docs-owned objects.
- Use Deliver when the next outcome is complete delivery, including planning,
  repairs, pending checks or merge. A stage change does not require a new prompt.
- Use a manual mode when the user wants its bounded result, such as an independent
  Review or a PR without merge. Explain the reason instead of inventing a gate.
- For broad Roadmap selection, follow [Next's order](next.md#select-one-issue).
  A new parent chain is suggested only when the user asks for chain delivery.
  Resume a valid interrupted chain when that is the work being continued.
- A named decision, another owner, missing authority or failed audit is a
  prerequisite. A manual mode cannot bypass it.

Selecting new Roadmap work needs Next's audit. Continuing a known public issue
or PR does not need a whole-Roadmap audit. A completed outcome needs no invented
follow-up. Suggestions neither start work nor expand authority.

## Report the result

Keep the response proportional. State the target and outcome, relevant revisions,
changes made, checks and missing evidence, documentation impact, and remaining
work. Distinguish local, pushed, merged, partial, failed and unavailable results.
For ref changes, include a safe recovery path. Report elapsed time or a bottleneck
when measured and useful; do not add work merely to populate a report.

Every completed mode or orientation ends with one exact copy-ready line:

```text
Suggested next prompt: Deliver - Target: Issue #123
```

Use observed identities. When no useful safe action is established, write
`Suggested next prompt: none` and explain why. Ordinary tasks need no such footer.
Use clickable absolute file paths in private chat when useful; never commit
machine-specific paths. Apply the [privacy boundary](private-authority.md#privacy)
to the destination of every report.
