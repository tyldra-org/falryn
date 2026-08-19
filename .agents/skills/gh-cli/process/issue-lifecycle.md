# issue lifecycle

GitHub-side rituals when work **starts**, **lands**, and **hands off** to the next slice. Tool syntax lives in [issues.md](issues.md) and [projects.md](projects.md). Local checkout sync lives in **git-workflow** → [delivery-checkout.md](../../git-workflow/reference/delivery-checkout.md).

Project-specific delivery loops (for example a repo's `Deliver` mode) may add selectors and stop rules; this file owns the **generic GitHub objects** every agent should reconcile.

## Work start (before the first commit)

When an agent begins an owned issue or PR-sized slice:

1. **Assign** the issue if the team uses assignees for ownership visibility.
2. Set the item's Project **Status** to **In Progress** (or the repo's equivalent active state).
3. If the issue is a **child of an open parent/epic** and this is the first active child, set the **parent** to **In Progress** too — not **Done**, not left in backlog unless the team explicitly keeps epics in backlog until close.
4. **Verify** with read-only queries; repair explicitly if wrong. Do not assume Project automation or PR-open workflows did it.

```bash
gh issue view <n> --repo OWNER/REPO --json state,assignees,projectItems,parent
gh project item-list <project-number> --owner OWNER --limit 1000 --format json
```

Resolve Project field and option IDs before mutating — see [projects.md](projects.md#update-fields).

## Work landed (after merge)

Merge closes issues when the PR body uses closing keywords; Project workflows may move status to **Done**. **Automation is not completion proof.** After each landed PR, audit and repair:

| Object | Typical expectation |
| --- | --- |
| Closed slice issue | `state: CLOSED`; Project **Done** (or team equivalent) |
| Open parent/epic | Stays **In Progress** until integrated verification passes and the epic closes |
| Next sibling (serial delivery) | Assign owner; **In Progress** before its Implement start |
| Milestone / parent rollup | Matches the team's rollup rules |

Verify:

```bash
gh issue view <child> --repo OWNER/REPO --json state,assignees,projectItems
gh issue view <parent> --repo OWNER/REPO --json state,projectItems
gh pr view <n> --repo OWNER/REPO --json state,mergedAt,mergeCommit
```

Repair with `gh issue edit`, `gh project item-edit`, and related commands from [issues.md](issues.md) and [projects.md](projects.md).

Then synchronize local checkouts per **git-workflow** → [delivery-checkout.md](../../git-workflow/reference/delivery-checkout.md).

## Single slice vs serial multi-child delivery

Two common orchestration patterns. A project-specific loop names its selectors; the GitHub obligations are the same.

| Pattern | Scope per agent run | After one child lands |
| --- | --- | --- |
| **Single-child handoff** | One child slice | Stop; human or next prompt starts the next sibling |
| **Serial chain** | Every remaining child, one after another | Reconcile, then **continue** the next sibling in the **same run** without treating merge as run complete |

**Serial chain — do not end the run after:**

- merge alone;
- opened PR or started CI;
- a status summary;
- a resume prompt while siblings remain and the host did not cut the turn.

**Serial chain — allowed stops:**

- awaiting explicit product input;
- failed merge preconditions;
- exhausted repair budget defined by the project loop.

CI wait is not a stop. When a project-specific delivery skill is loaded, follow
its serial-chain and CI-wait rules; otherwise background-watch per [ci.md](ci.md).

While a serial chain is in flight, reports should state explicit progress, for example:

```text
Epic #P: #A Done → #B in progress → #C–#E pending
```

## Relationship to delivery bundles

Multi-repository or docs-then-code landing order: [delivery.md](delivery.md).

Long-running CI: [ci.md](ci.md).

Project field mechanics: [projects.md](projects.md).
