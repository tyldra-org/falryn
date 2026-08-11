---
name: typescript-pro
description: Implements branded types, type guards, custom utility types, and type-safe API patterns. Use when designing type-first APIs, narrowing at boundaries, or building reusable type utilities. For type-system tutorials use advanced-types; for tsc performance use compiler.
---

# TypeScript Pro

Implementation-focused patterns. Load references only for the topic at hand.

## Workflow

1. Inspect `tsconfig`, public exports, and type coverage of the touched surface.
2. Design types before implementation (brands, unions, generics, utilities).
3. Implement with guards / predicates; run the repo typecheck (`tsc --noEmit` or project script).
4. Tighten config only if the project already uses those flags; re-typecheck.
5. For libraries: explicit return types on exports; optional type tests.

## References

| Topic | File | Load when |
| --- | --- | --- |
| Advanced types | `references/advanced-types.md` | Generics, conditionals, mapped, template literals |
| Type guards | `references/type-guards.md` | Narrowing, predicates, assertions, discriminants |
| Utility types | `references/utility-types.md` | Builtin + custom utilities |
| Configuration | `references/configuration.md` | Strict flags, project references, declarations |
| Patterns | `references/patterns.md` | Builder, factory, type-safe APIs |

Type-system tutorials with worked examples → `modules/typescript-advanced-types/GUIDE.md`.  
Everyday idioms (Zod, exhaustive switch) → `modules/typescript-best-practices/GUIDE.md`.

## Quick patterns

### Brand

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };
type UserId = Brand<string, "UserId">;
type OrderId = Brand<number, "OrderId">;

const toUserId = (id: string): UserId => id as UserId;
```

### Discriminated union + guard

```ts
type RequestState =
  | { status: "loading" }
  | { status: "success"; data: string[] }
  | { status: "error"; error: Error };

function isSuccess(
  state: RequestState
): state is Extract<RequestState, { status: "success" }> {
  return state.status === "success";
}

function render(state: RequestState): string {
  switch (state.status) {
    case "loading":
      return "Loading…";
    case "success":
      return state.data.join(", ");
    case "error":
      return state.error.message;
    default: {
      const _exhaustive: never = state;
      throw new Error(`Unhandled: ${_exhaustive}`);
    }
  }
}
```

### Useful utilities

```ts
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

type RequireExactlyOne<T, Keys extends keyof T = keyof T> = Pick<
  T,
  Exclude<keyof T, Keys>
> &
  {
    [K in Keys]-?: Required<Pick<T, K>> &
      Partial<Record<Exclude<Keys, K>, never>>;
  }[Keys];
```

## Constraints

**Do**

- Strict mode; justify any relaxation
- Type-first public APIs; branded domain IDs where mix-ups are costly
- `satisfies` when you need constraint + inference
- Discriminated unions for state machines
- Declaration emit for publishable packages

**Don't**

- Bare `any` without a boundary + comment
- Unnecessary `as` assertions
- Disable strict null checks to silence errors
- Prefer numeric `enum` over const objects / unions
- Mix type-only and value imports carelessly (use `import type`)

## Output shape

When implementing: (1) types, (2) guards/implementation, (3) tsconfig deltas only if needed, (4) one-sentence rationale for non-obvious type design.
