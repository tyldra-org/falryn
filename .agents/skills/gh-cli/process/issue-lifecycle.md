# Issue lifecycle

Reconcile generic GitHub issue and Project state when work starts or lands. Repository-specific readiness, sequencing, parent-completion, and stop rules belong to that repository's workflow contract.

## Start

When policy uses these fields:

1. assign the active owner;
2. move the exact Project item to its active status;
3. update an open parent only when repository rules require it;
4. re-read issue, parent, and Project state.

Use the readable single-item selectors or resolve Project field and option IDs through [projects.md](projects.md), depending on the installed CLI and whether the operation is scripted. Never infer an ambiguous field or option from display order.

## After merge

A closing keyword or Project automation is not completion proof. Re-read:

- PR state, merge commit, base branch, and merge time;
- owning issue state and assignee;
- Project status and other governed fields;
- native parent, child, and blocker relationships;
- milestone or rollup state required by repository policy.

Repair only fields authorized by the loaded repository contract. Distinguish automation success, manual repair, and unresolved mismatch in the report.

Local default-branch synchronization remains owned by `git-workflow` and its [delivery checkout guide](../../git-workflow/reference/delivery-checkout.md).

## Related guides

- issue metadata and relationships: [issues.md](issues.md)
- Project mechanics: [projects.md](projects.md)
- dependent multi-PR landing: [delivery.md](delivery.md)
- checks and Actions: [ci.md](ci.md)
