# Reliability

Design for real failures, concurrent actors, retries, and direct proof.

## Fix causes, not symptoms

Reproduce the failure or establish the smallest observable baseline. Trace the
actual data and control path, inspect the first incorrect state, and instrument
when evidence is missing. A guard that only suppresses the visible crash is not
a fix unless absence is a valid domain state and the boundary owns that result.

For restart-only failures, inspect persisted state, leases, caches, partial
writes, and version transitions before assuming executable code changed. Search
for the same causal pattern beyond the first instance.

## Separate mutable ownership

When actors may write the same file, key, branch, record, or in-memory object,
first determine whether they need one shared object. Prefer per-owner state with
a deterministic read-time aggregation boundary.

When shared mutation is a real invariant, enforce one structural protocol:
single-writer ownership, transaction, lock with recoverable identity, compare-
and-swap, fencing token, or serialized phase. Instructions to “take turns” are
not concurrency control. PID liveness or elapsed time alone is not authority;
stale writers must be unable to commit after takeover.

## Make repetition converge

A mutating operation should define what happens after duplicate delivery and
a crash at each mutation boundary. Use stable operation identities, atomic
publication, compare-before-write, durable settlement, and restart
reconciliation where the risk warrants them.

Local lease expiry may free local capacity; it does not prove a remote effect
did not happen. Do not blindly retry partial or uncertain effects. Observe or
reconcile them, use a provider-supported idempotency key, or require an explicit
recovery decision.

## Prove the real path

Compilation and mocks are necessary evidence only when they match the risk. Run
the actual feature path when practical, inspect the produced artifact or state,
and verify input-to-output behavior, failure handling, cleanup, and restart or
repeat behavior.

Use a deterministic check when it is cheaper and more reliable than a one-time
manual comparison. Keep evidence reproducible, but do not add permanent test
machinery whose maintenance exceeds the regression risk.

Delegated summaries and green aggregate checks are pointers, not proof. Inspect
the relevant diff, output, logs, or persisted result and report what remained
unverified.
