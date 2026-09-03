# Advanced TypeScript types

Use when a reusable API needs non-trivial inference, narrowing, brands, conditional or mapped types. Keep the public contract simpler than the implementation whenever possible.

## Escalation order

1. Built-in utility types: `Pick`, `Omit`, `Partial`, `Required`, `Readonly`, `Record`, `Exclude`, `Extract`, `NonNullable`, `Parameters`, `ReturnType`, `Awaited`.
2. Generic constraints that express the minimum capability.
3. Discriminated unions and user-defined guards.
4. Mapped or conditional types.
5. Template-literal types and bounded recursion only when the API truly benefits.

## Core patterns

```ts
function getProperty<T, K extends keyof T>(value: T, key: K): T[K] {
  return value[key];
}

type ElementOf<T> = T extends readonly (infer Item)[] ? Item : never;

type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

type EventName<Key extends string> = `${Key}Changed`;
```

Avoid user-authored compiler intrinsics. Do not model every HTTP method, state, or field as present merely to simplify a generic constraint.

## Inference and `satisfies`

`satisfies` checks assignability while preserving the type TypeScript infers under the expression's contextual typing rules. It does not guarantee that every nested literal remains narrow. Verify the actual inferred type when literal preservation matters.

```ts
const routes = {
  home: "/",
  profile: "/profile",
} as const satisfies Record<string, string>;

type Route = (typeof routes)[keyof typeof routes];
```

## Brands and guards

A brand prevents accidental mixing after construction; it does not validate raw data.

```ts
declare const userIdBrand: unique symbol;
type UserId = string & { readonly [userIdBrand]: true };

function parseUserId(value: string): UserId | undefined {
  return value.length > 0 ? (value as UserId) : undefined;
}
```

Use predicates and assertion functions only when their implementation actually proves the promised type.

## Type tests

For public or complex inference, add compile-time assertions using the repository's existing type-test tool. Cover accepted and rejected calls, inferred return/property types, readonly behavior, union distribution, and recursion limits. Use `@ts-expect-error` only for a deliberate negative case and require that it fails if the error disappears.

See [validated patterns](references/patterns.md) for an event map, state-safe builder, and exact-one utility.

## Constraints

- Prefer `unknown` to `any` at unresolved boundaries.
- Cap recursive depth and large generated unions.
- Name complex types for diagnostics and compiler reuse.
- Document invariants that a type cannot express at runtime.
- Measure checker cost before weakening a useful contract.
