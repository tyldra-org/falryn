# Validated advanced-type patterns

Adapt these to repository conventions; they are examples, not required abstractions.

## Event map

```ts
interface Events {
  ready: { readonly at: number };
  failed: { readonly error: Error };
}

type Handler<T> = (event: T) => void;

class Emitter<EventMap extends object> {
  readonly #handlers = new Map<keyof EventMap, Set<Handler<never>>>();

  on<Key extends keyof EventMap>(key: Key, handler: Handler<EventMap[Key]>): () => void {
    const handlers = this.#handlers.get(key) ?? new Set<Handler<never>>();
    handlers.add(handler as Handler<never>);
    this.#handlers.set(key, handlers);
    return () => handlers.delete(handler as Handler<never>);
  }

  emit<Key extends keyof EventMap>(key: Key, event: EventMap[Key]): void {
    for (const handler of this.#handlers.get(key) ?? []) {
      handler(event as never);
    }
  }
}
```

The internal cast is confined to erased heterogeneous storage. The public methods preserve the key-to-payload relationship. Prefer a library or separate storage when the implementation cast is unacceptable.

## State-safe builder

```ts
type Missing = { readonly name: false; readonly email: false };
type Present = { readonly name: true; readonly email: true };

class UserBuilder<State extends { readonly name: boolean; readonly email: boolean }> {
  declare private readonly state: State;

  private constructor(private readonly value: Partial<{ name: string; email: string }>) {}

  static create(): UserBuilder<Missing> {
    return new UserBuilder({});
  }

  withName(name: string): UserBuilder<Omit<State, "name"> & { readonly name: true }> {
    return new UserBuilder({ ...this.value, name });
  }

  withEmail(email: string): UserBuilder<Omit<State, "email"> & { readonly email: true }> {
    return new UserBuilder({ ...this.value, email });
  }

  build(this: UserBuilder<Present>): { readonly name: string; readonly email: string } {
    return { name: this.value.name!, email: this.value.email! };
  }
}
```

The private representation is intentionally partial; the `this` constraint restricts public `build` calls. Add runtime validation if values come from untrusted input.

## Require exactly one

```ts
type RequireExactlyOne<T, Keys extends keyof T = keyof T> =
  Omit<T, Keys> & {
    [Key in Keys]: Required<Pick<T, Key>> &
      Partial<Record<Exclude<Keys, Key>, never>>;
  }[Keys];
```

Use only when the runtime parser enforces the same invariant.
