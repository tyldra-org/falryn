# Apply an ordered PR bundle

Use this guide when a user or repository workflow already establishes a delivery
involving dependent PRs. The repository owns admission, acceptance and landing
order. This guide handles GitHub effects; it does not select new work or invent
required companion PRs.

## Resolve the bundle

Record the outcome, repositories, PR identities, dependencies, current base/head
SHAs, selected merge methods and complete messages. Establish required evidence
and expected closing or automation effects. Resolve an unsafe intermediate state
before the first merge; cross-repository landing is not atomic.

Check [authorization](../SKILL.md#authorization-and-evidence) for the whole bundle.
An authorized outcome may cover evolving revisions after renewed verification.
An approval explicitly tied to immutable revisions does not. Added outcomes or
uncovered effects require scope resolution, not automatic inclusion.

## Land and verify serially

For each member in the declared order:

1. Establish current review and validation evidence, including assumptions affected
   by earlier merges. Inspect live head/base, checks, reviews and rules.
2. Execute the single [merge procedure](merge.md) with its reviewed revision and
   complete message. It also owns queue handling and uncertain responses.
3. Verify the actual result and any dependency effects before starting the next
   member. Reconcile authorized issue or Project fields through
   [issue lifecycle](issue-lifecycle.md).

If a member changed, refresh affected evidence before proceeding. If the result
is unexpected, pause dependent effects, inspect actual state and recover within
the existing scope. Keep independent safe work possible. Never force a later merge
to hide a partial delivery or assume rollback is authorized.

## Finish the bundle

Verify all required members and their integration effects. Report each merged,
queued, pending or failed member with its relevant revision. Completion requires
the repository's acceptance evidence, not just successful API calls.

Use [delivery checkout](../../git-operations/reference/delivery-checkout.md) for
eligible local synchronization. Preserve incomplete or unrelated work. Report
remaining acceptance, automation or reconciliation gaps without inventing new
Project policy, release steps or branch cleanup.
