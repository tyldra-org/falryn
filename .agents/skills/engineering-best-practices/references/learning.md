# Learning

Turn repeated corrections into stronger system structure.

## Route the lesson

After a human correction, recurring defect, flaky workflow, or surprising
failure, decide whether it is:

- a one-off fact to record with the current work;
- a recurring practice that belongs in a focused skill or canonical helper;
- an enforceable invariant that belongs in a type, schema, lint rule, test,
  runtime guard, or CI check; or
- a systemic ownership flaw that needs a design change.

Recording without changing the owning mechanism leaves the loop open.

## Choose the strongest practical enforcement

Prefer, in order:

1. a state that cannot be represented or constructed;
2. one authoritative generated value or schema;
3. a compile-time or lint failure;
4. a canonical API that makes the correct path easiest;
5. a runtime boundary check with a typed failure;
6. a deterministic audit or test; and
7. prose only when judgment cannot be encoded safely.

Stronger is not always broader. Enforcement must live with the owner, avoid
false positives, expose a useful recovery path, and remain proportionate to the
risk.

## Close the loop

Apply the smallest durable improvement now when it fits the task. Otherwise
create a concrete owned follow-up with the failure evidence and completion
condition. Remove obsolete prose after structure makes it redundant; do not
maintain two competing sources of truth.

Revisit safeguards that repeatedly need bypasses. The rule may be at the wrong
boundary, encode the wrong invariant, or impose more cost than the failures it
prevents.
