# TypeScript verification

Use this reference to choose evidence for a TypeScript contract. General testing
strategy belongs to engineering guidance; defect assessment and report shape
belong to `change-review`. Run the repository's required checks after focused proof.

## Match the check to the claim

| Changed contract | Useful evidence |
| --- | --- |
| Inference, generics, overloads or accepted call shapes | Positive and negative compiler fixtures using the selected compiler |
| External data or JavaScript callers | Runtime input and rejection cases, including values the type system cannot constrain |
| Async or disposable API | Observable cancellation, rejection, ordering and cleanup through the real caller |
| Resolution, exports or declarations | Import the built package as a separate consumer under each supported condition |
| Compiler API, transform or language-service integration | Exercise the actual integration with its supported package and host |
| Framework-specific behavior | Use that framework's renderer or build where it owns the behavior |
| Performance | Compare the affected workload with the same toolchain and environment |

A successful typecheck does not prove runtime input safety. A runtime test does
not prove the published declaration can be consumed. Lint and formatting establish
configured style rules, not either of those contracts.

## Assert type failures deliberately

Use the existing type-test tool or compiler fixture. Include an accepted call and
a rejected call when both are part of the API:

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

The negative assertion must fail if the compiler stops rejecting the invalid call.
Keep suppression next to that assertion, not in ordinary implementation to hide an
unknown value. Compile public examples under the supported configuration before
presenting them as working code.
