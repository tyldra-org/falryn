# Type-system design

Use advanced types to improve a public contract, not to demonstrate type-level
cleverness. Keep the public surface simpler than the implementation when
possible.

## Escalation order

1. built-in utility types such as `Pick`, `Omit`, `Partial`, `Required`,
   `Readonly`, `Record`, `Exclude`, `Extract`, `NonNullable`, `Parameters`,
   `ReturnType`, and `Awaited`;
2. generic constraints that express the minimum capability;
3. discriminated unions and runtime guards;
4. mapped and conditional types;
5. template literal types and bounded recursion.

```ts
function getProperty<T, Key extends keyof T>(value: T, key: Key): T[Key] {
  return value[key];
}

type ElementOf<T> = T extends readonly (infer Item)[] ? Item : never;
type Optional<T, Key extends keyof T> = Omit<T, Key> & Partial<Pick<T, Key>>;
type EventName<Key extends string> = `${Key}Changed`;
```

## Preserve useful inference

`satisfies` checks compatibility while retaining the inferred expression type.
It does not promise that every nested literal remains narrow, so inspect the
actual inferred type when literal precision matters.

```ts
const routes = {
  home: "/",
  profile: "/profile",
} as const satisfies Record<string, string>;

type Route = (typeof routes)[keyof typeof routes];
```

Avoid explicit generic arguments when inference already communicates the
contract. Add them when inference lacks required information or a public example
needs to pin intended behavior.

## Brands require constructors

A brand prevents accidental mixing after construction. It does not validate raw
data.

```ts
declare const userIdBrand: unique symbol;
type UserId = string & { readonly [userIdBrand]: true };

function parseUserId(value: unknown): UserId | undefined {
  return typeof value === "string" && /^usr_[a-z0-9]{12}$/.test(value)
    ? (value as UserId)
    : undefined;
}
```

Confine the assertion to the constructor that checks the runtime invariant.
Callers should not create the brand with standalone casts.

## Keep correlated types correlated

Generic keys can preserve a relationship between an event name and its payload:

```ts
interface Events {
  ready: { readonly at: number };
  failed: { readonly error: Error };
}

type Event<Map extends object> = {
  [Key in keyof Map]: readonly [key: Key, payload: Map[Key]];
}[keyof Map];

function logEvent([key, payload]: Event<Events>): void {
  if (key === "ready") {
    console.log(payload.at);
  } else {
    console.error(payload.error);
  }
}
```

The discriminated tuple keeps each key paired with its payload. If heterogeneous
runtime storage still forces an internal cast, keep it private and test the
public relationship. Prefer separate storage if the cast would spread across
callers.

## Encode exact choices sparingly

```ts
type RequireExactlyOne<T, Keys extends keyof T = keyof T> =
  Omit<T, Keys> & {
    [Key in Keys]: Required<Pick<T, Key>> &
      Partial<Record<Exclude<Keys, Key>, never>>;
  }[Keys];
```

Use such a utility only when the runtime parser enforces the same invariant and
the resulting diagnostics remain understandable.

## Prove type behavior

Use the repository's existing type-test approach. Test accepted calls, rejected
calls, inferred return and property types, readonly behavior, union
distribution, and recursion limits.

```ts
declare const id: UserId;
const text: string = id;

// @ts-expect-error Raw strings have not passed the UserId parser.
const unsafeId: UserId = "usr_123456789abc";

void text;
void unsafeId;
```

`@ts-expect-error` belongs only on a deliberate negative type test. It must fail
when the expected compiler error disappears.

## Review checks

- A simpler union, overload, or built-in utility was considered first.
- The type models a real invariant shared by callers.
- Runtime validation matches the static claim.
- Recursive and generated unions have explicit limits.
- Complex types are named so diagnostics and checker caches can reuse them.
- Public diagnostics are usable by consumers.
