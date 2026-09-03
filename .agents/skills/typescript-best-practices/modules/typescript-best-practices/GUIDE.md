# TypeScript core

Use for ordinary TypeScript and JavaScript implementation. Repository conventions and existing domain types win.

## Start at the boundary

Identify which values are trusted, parsed, persisted, sent, or rendered. Keep transport input `unknown` until a validator or explicit guard establishes the domain shape. Use the validation library already present; do not introduce one merely for style.

```ts
type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

interface Account {
  readonly id: string;
  readonly email: string;
}

function parseAccount(input: unknown): ParseResult<Account> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, reason: "account must be an object" };
  }

  const value = input as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.email !== "string") {
    return { ok: false, reason: "account fields are invalid" };
  }

  return { ok: true, value: { id: value.id, email: value.email } };
}
```

When the project uses a schema library, derive types from schemas when that keeps one source of truth. Treat coercion and transforms as behavior requiring tests.

## Represent domain states directly

Use discriminated unions when fields are conditionally valid:

```ts
type RequestState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "failure"; error: Error };
```

Prefer separate branded or opaque identifiers when mixing identical primitives would be costly. Keep brand construction behind validated functions; a cast alone does not validate input.

Use const objects or literal arrays for closed runtime vocabularies:

```ts
const roles = ["admin", "member", "guest"] as const;
type Role = (typeof roles)[number];
```

Exhaust state machines with `never`:

```ts
function label(state: RequestState<unknown>): string {
  switch (state.status) {
    case "idle": return "Idle";
    case "loading": return "Loading";
    case "success": return "Complete";
    case "failure": return state.error.message;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}
```

## Errors and effects

- Use exceptions for exceptional failure when the surrounding API does.
- Use a discriminated result when callers are expected to branch on ordinary outcomes.
- Preserve causes and stable error codes at subsystem boundaries.
- Never catch an error merely to erase it, return a misleading success, or replace evidence with a generic message.
- Model partial or uncertain effects separately from ordinary failure when external work may have happened.

## Async and concurrency

- Start independent work together only when ordering, authority, rate limits, and resource bounds permit it.
- Use bounded concurrency for collections; `Promise.all` is not a concurrency limit.
- Thread `AbortSignal` through operations that can outlive their caller and settle cleanup deterministically.
- Await or intentionally retain every promise; do not create floating work accidentally.
- Do not retry non-idempotent or effect-uncertain work without reconciliation.

```ts
async function loadPair(signal: AbortSignal): Promise<readonly [User, Team]> {
  const userPromise = loadUser(signal);
  const teamPromise = loadTeam(signal);
  return Promise.all([userPromise, teamPromise]);
}
```

## Modules and APIs

- Prefer explicit exports and direct imports; use barrels only when they are a deliberate public boundary and the toolchain handles them correctly.
- Use `import type` when the repository's compiler settings preserve import syntax.
- Keep runtime initialization visible; avoid import-time effects that hide I/O, registration, or mutable global state.
- Annotate public return types when they define a contract or stabilize declarations; local obvious inference is usually clearer.
- Prefer `satisfies` when you need constraint checking without replacing the inferred expression type.

## Review checklist

- Runtime boundary is validated, not asserted.
- State combinations are representable only when valid.
- Optional and indexed values are handled under the repository's strict settings.
- Errors retain useful identity and context.
- Concurrency has explicit ordering, cancellation, and capacity assumptions.
- Public exports, module side effects, and compatibility impact are intentional.
- Tests cover success, boundary rejection, and relevant failure or cancellation paths.
