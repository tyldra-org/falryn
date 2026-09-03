---
name: engineering-best-practices
description: >-
  Cross-language software engineering judgment for non-trivial design,
  debugging, refactoring, migrations, concurrency, reliability, maintainability,
  and verification. Use when the work needs architectural or execution
  discipline beyond a stack-specific API guide. Skip for routine mechanical
  edits and simple factual questions.
---

# Engineering best practices

Use this skill to choose the shape and proof of a change. Pair it with the
relevant language, framework, review, Git, or delivery skill; it does not
replace those owners.

## Operating method

1. **Resolve the outcome and authority.** State what must be true, what must not
   change, and which user, repository, safety, or external-action rules govern.
2. **Inspect the real boundary.** Read the current types, callers, state owners,
   failure paths, and validation commands before choosing a design.
3. **Choose the smallest coherent shape.** Prefer subtraction and domain-shaped
   structures over adapters, flags, and speculative extensibility.
4. **Work in verifiable units.** Keep one clear owner per mutable artifact,
   automate repetition when it improves repeatability, and prove each unit
   before building on it.
5. **Verify the outcome directly.** Exercise the real path, inspect the actual
   artifact, and report incomplete, partial, unavailable, or uncertain evidence
   honestly.

## Rules

- Higher-priority safety, user, repository, and delivery contracts always win.
- Reversible local implementation should proceed when intent is clear.
  Irreversible, privileged, destructive, or outward-facing actions still need
  the required confirmation.
- Validate untrusted representations at their boundary, then pass typed domain
  values inward. Revalidate only when authority, version, freshness, or trust
  can change.
- Idempotency never licenses blind retry of a possibly completed external
  effect. Reconcile uncertain effects or require a stable idempotency contract.
- Temporary breakage may exist inside an isolated experiment, not in a
  delivered unit presented as complete.
- Do not introduce a lever, abstraction, prototype, or document unless its
  confidence or reuse value exceeds its maintenance cost.

## Routing

| Concern | Read |
| --- | --- |
| Product experience, architecture, boundaries, domain models, types, or novel design choices | [Design](references/design.md) |
| Planning, sequencing, automation, context use, or autonomous progress | [Execution](references/execution.md) |
| Refactoring, reducing indirection, API migration, or maintainability | [Simplicity](references/simplicity.md) |
| Debugging, concurrency, retries, crash recovery, or proof | [Reliability](references/reliability.md) |
| Turning repeated corrections into durable safeguards | [Learning](references/learning.md) |

Load one primary reference. Add another only for a distinct cross-cutting risk.

## Completion check

Before declaring done, answer:

- Does the result satisfy the user-visible outcome rather than only compile?
- Is each invariant owned once and enforced at the strongest practical layer?
- Can a future reader locate state, authority, and failure handling quickly?
- Can the operation restart or repeat without duplication, corruption, or
  concealed uncertainty?
- Is the evidence direct, current, reproducible, and proportionate to risk?
