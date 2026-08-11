---
name: typescript-advanced-types
description: Advanced TypeScript type system—generics, conditional types, mapped types, template literals, and utility types. Use when building reusable type utilities, library APIs, or compile-time inference logic. Not for everyday idioms, tsc tuning, or React review.
---

# Advanced Types

Type-level programming for libraries and complex inference. Keep types as simple as the problem allows; escalate complexity only when it removes real bugs.

For implementation patterns (guards, builders, branded helpers) → `modules/typescript-pro/GUIDE.md`.  
For type-instantiation / compile cost → `modules/typescript/GUIDE.md`.

## When to use

- Reusable generic APIs or form/config/state type systems
- Conditional / mapped / template-literal type logic
- Custom utility types beyond builtins
- Type tests for public generics

## Core map

| Topic | Start here |
| --- | --- |
| Generics & constraints | Section below |
| Conditional types / `infer` | Section below + [details.md](references/details.md) |
| Mapped & template-literal types | Section below + [details.md](references/details.md) |
| Builtin utilities | Section below |
| Worked patterns (event emitter, etc.) | [details.md](references/details.md) |

## Generics

```ts
function identity<T>(value: T): T {
  return value;
}

interface HasLength {
  length: number;
}

function logLength<T extends HasLength>(item: T): T {
  console.log(item.length);
  return item;
}

function merge<T, U>(obj1: T, obj2: U): T & U {
  return { ...obj1, ...obj2 };
}
```

## Conditional types

```ts
type IsString<T> = T extends string ? true : false;
type Flatten<T> = T extends Array<infer U> ? Flatten<U> : T;
type NonNullable<T> = T extends null | undefined ? never : T;
```

Prefer named aliases for complex conditionals (compiler caching). Cap recursion; see compiler rules `type-extract-conditional-types` and `type-limit-recursion-depth`.

## Mapped types

```ts
type ReadonlyDeep<T> = {
  readonly [K in keyof T]: T[K] extends object ? ReadonlyDeep<T[K]> : T[K];
};

type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
```

Prefer `interface` for object shapes when performance matters; use `type` for unions, mapped, and conditional forms.

## Template literal types

```ts
type EventName<T extends string> = `on${Capitalize<T>}`;
type PropEventSource<Type> = {
  on<Key extends string & keyof Type>(
    eventName: `${Key}Changed`,
    callback: (newValue: Type[Key]) => void
  ): void;
};
```

## Builtin utilities (prefer before inventing)

`Partial`, `Required`, `Readonly`, `Pick`, `Omit`, `Exclude`, `Extract`, `NonNullable`, `Record`, `ReturnType`, `Parameters`, `Awaited`.

## Type testing

```ts
type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

type _ok = AssertEqual<string, string>; // true
```

For Vitest `expectTypeOf` workflows → `modules/typescript-expert/GUIDE.md`.

## Pitfalls

- Prefer `unknown` over `any`
- Avoid deep recursive / huge union types (quadratic / exponential cost)
- Prefer discriminated unions for narrowing
- Document non-obvious type utilities with JSDoc

## Details

Worked examples (typed event emitter, builders, form paths, etc.): [references/details.md](references/details.md).
