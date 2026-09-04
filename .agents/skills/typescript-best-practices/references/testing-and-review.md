# Testing and review

Match verification to the contract that changed. Do not treat one green tool as
universal proof.

## Separate proof layers

- Compiler checks prove static compatibility for the included program.
- Lint and formatting checks prove configured policy.
- Runtime tests prove exercised behavior.
- Framework builds prove selected framework contracts and bundling.
- Declaration generation proves that types can be emitted.
- Consumer tests prove that another project can load the shipped contract.
- Benchmarks prove only the measured workload and environment.

Start focused, then widen according to the changed boundary.

## Test runtime behavior

For parsers, handlers, effects, and adapters, cover:

- representative success;
- malformed and structurally valid but semantically invalid input;
- dependency failure and preserved error identity;
- cancellation before start and during work;
- partial startup and cleanup;
- ordering and concurrency limits;
- migration compatibility.

Prefer observable contracts over private implementation details. A test that
cannot fail when the intended behavior breaks is not useful evidence.

## Test type contracts

Use the repository's existing type-test tool or compiler fixture. Include
positive and negative cases when inference is part of the API.

```ts
type Command =
  | { readonly kind: "open"; readonly path: string }
  | { readonly kind: "close"; readonly force?: boolean };

declare function dispatch(command: Command): void;

dispatch({ kind: "open", path: "/tmp/report.txt" });

// @ts-expect-error An open command requires a path.
dispatch({ kind: "open" });

// @ts-expect-error A close command does not accept a path.
dispatch({ kind: "close", path: "/tmp/report.txt" });
```

Keep `@ts-expect-error` next to a deliberate negative assertion. Avoid it in
ordinary implementation code.

## Review by consequence

1. Identify the owning contract and its callers.
2. Trace success, rejection, failure, cancellation, and cleanup paths.
3. Compare static claims with runtime validation.
4. Inspect compiler, runtime, framework, and package behavior separately.
5. Assign severity from reachable user or system consequences.
6. Cite exact evidence and state unverified assumptions.

Useful questions include:

- Can external data reach the domain through an assertion?
- Can stale async work overwrite newer state?
- Can a failed effect be retried safely?
- Can editor resolution succeed while runtime resolution fails?
- Can declarations expose a private or missing type?
- Can a migration leave two authorities or an adapter with no deletion path?

## Completion checks

- Commands, versions, inputs, and outcomes are reported exactly.
- Negative and failure paths are exercised where they carry risk.
- Public examples compile against the supported configuration.
- Package changes include a consumer-shaped check.
- Performance claims include comparable measurements.
- Skipped or unavailable validation remains explicit.
