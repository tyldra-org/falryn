# Execution

Keep one workflow in the current task. These rules govern evidence reuse and
state changes within the selected operation; its finish line remains in
[the mode table](../SKILL.md#choose-the-operation).

## Reuse evidence, refresh changing facts

Keep only the working facts needed to continue: scope and acceptance, owners,
source/docs/base/head revisions, completed checks and their inputs, blockers,
observed external effects and next action. Use task context or an existing
private artifact, not another repository tracker or execution runtime.

Read each instruction and owner once per unchanged revision. A new phase or
prompt does not invalidate evidence. Validation is reusable only for matching
revision, dependencies, configuration, toolchain, environment and scope.

| Change | Refresh before relying on it |
| --- | --- |
| PR head or base | Complete current diff review, affected validation and Verify |
| Issue contract, hierarchy, blockers, assignee or Project facts | Admission and affected governance audits |
| Documentation owner or companion | Impact, bundle membership and verification |
| Check, review, ruleset, mergeability or repository setting | Merge preflight |
| Authentication, repository or checkout | Authority and safe mutation target |

Required live reads cannot be replaced by cached conclusions. A changed fact is
normally a reason to refresh evidence and continue authorized work. Stop for
user input only when intent or authority is unresolved, a human decision is
needed, or the next action exceeds the granted scope. An incomplete contract
blocks implementation, but Plan inside Deliver can resolve derivable facts.

## Execute without redundant work

Batch independent reads and checks with stable inputs. Keep one writer per
checkout and dependent mutations sequential. Parent children run serially.
Delegate only a bounded task when current instructions allow it and it adds
useful evidence; do not create an agent for every workflow stage.

Use focused checks during implementation, then the complete validation required
by `DEVELOPMENT.md` before review. Add applicable compiled or platform checks.
Read-only routing and planning need no product build without a proof need.
Do not rerun successful unchanged checks just because the mode changed, and do
not replace required full validation with changed-file tests.

Observe CI using the `gh-cli` waiter. Complete independent work while it runs,
then wait for settlement without busy polling. Use [audit commands and scopes](governance-audits.md)
when governance facts change; replay proves only its captured generation.

## Mutate and recover deliberately

Before a GitHub body or field change, retain the exact preimage, inspect the
complete candidate, re-read live state and apply only the intended change.
Verify the result before dependent work. Keep private receipts outside public
artifacts. Bulk operations need bounded scope and per-object outcomes.

When an external result is uncertain, inspect state before retrying. Never repeat
a possibly completed merge, issue creation or field write blindly. Follow
[delivery recovery](deliver.md#recover-from-observed-state) for closed or merged
work. Report partial effects accurately.

Resolve an in-scope failure under existing authority and refresh its proof.
After three repair passes without changed evidence, stop for a different
strategy. Preserve useful completed work and name the unresolved condition.
Never bypass a failing hook or required check.
