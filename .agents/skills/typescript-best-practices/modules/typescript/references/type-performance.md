# Type-system performance

Measure first with the installed compiler. Optimize types only when diagnostics, traces, editor behavior, or reproducible builds show a real cost.

## High-value moves

- Name and reuse complex conditional or mapped types so the checker can reuse work and readers can understand intent.
- Prefer composable object interfaces where extension and declaration caching benefit; use intersections when their semantics are actually needed.
- Split very large unions or generated schemas along domain boundaries.
- Bound recursive types with an explicit depth or narrower domain.
- Reduce repeatedly distributed conditional types when a non-distributive form is intended:

```ts
type IsString<T> = [T] extends [string] ? true : false;
```

- Add explicit public return annotations when they stabilize an API or declaration emit; do not annotate every local expression mechanically.
- Move generic complexity out of hot call sites when a simpler public façade preserves the contract.

## Do not

- claim a percentage or multiplier without a benchmark from the affected project;
- replace a precise domain type with `any`, broad assertions, or an unvalidated cast for speed;
- assume every interface beats every intersection or every union is slow;
- optimize checker cost before confirming the bottleneck is type checking.

## Proof

Record the command, TypeScript version, cold/warm conditions, relevant diagnostic counters, and before/after result. Re-run correctness checks because a simpler type that accepts invalid states is not an optimization.
