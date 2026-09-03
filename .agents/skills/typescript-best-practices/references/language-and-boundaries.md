# Language and boundaries

Use TypeScript to preserve established facts. Use runtime code to establish
facts that types cannot know.

## Parse before domain use

Network responses, JSON, storage, environment variables, URL state, form data,
messages, and JavaScript callers are runtime inputs. Keep them `unknown` until a
parser or guard proves the required shape.

```ts
type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

type Account = {
  readonly id: string;
  readonly email: string;
};

function parseAccount(input: unknown): ParseResult<Account> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "account must be an object" };
  }

  const value = input as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.email !== "string") {
    return { ok: false, reason: "account fields are invalid" };
  }

  return { ok: true, value: { id: value.id, email: value.email } };
}
```

If the repository already uses a schema library, prefer one schema as the
runtime source of truth and derive the static type where supported. Coercion,
defaults, stripping, and transforms are behavior and need tests.

## Model valid states

Use discriminated unions when fields are valid only in certain states. Avoid a
single object with several unrelated optional fields.

```ts
type RequestState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly startedAt: number }
  | { readonly status: "success"; readonly data: T }
  | { readonly status: "failure"; readonly error: Error };

function describe(state: RequestState<unknown>): string {
  switch (state.status) {
    case "idle":
      return "Idle";
    case "loading":
      return `Started at ${state.startedAt}`;
    case "success":
      return "Complete";
    case "failure":
      return state.error.message;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}
```

Use literal arrays or const objects for closed vocabularies that also exist at
runtime:

```ts
const roles = ["admin", "member", "guest"] as const;
type Role = (typeof roles)[number];

const routeByRole = {
  admin: "/admin",
  member: "/home",
  guest: "/welcome",
} satisfies Record<Role, string>;
```

## Shape public APIs deliberately

- Annotate exported return types when they are a contract or when declaration
  stability matters. Let obvious local values infer naturally.
- Accept the narrowest capability needed. Do not require a large concrete type
  when one method or property is sufficient.
- Prefer explicit exports. Treat barrel files as public boundaries, not folder
  decoration.
- Use `import type` when the effective compiler configuration preserves the
  distinction.
- Keep runtime initialization visible. Avoid import-time I/O, registration, and
  mutation unless the module contract requires it.
- Use `readonly` to communicate ownership, not as a claim of deep runtime
  immutability.

## Preserve error meaning

Choose errors by caller behavior:

- throw when exceptional failure follows the surrounding API convention;
- return a discriminated result when ordinary outcomes require branching;
- retain stable codes and the original cause across subsystem boundaries;
- represent partial or uncertain external effects separately from clean failure;
- never catch only to erase evidence or return a false success.

```ts
class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

function requiredPort(value: unknown): number {
  const port = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError("port must be an integer from 1 through 65535");
  }
  return port;
}
```

## Review checks

- Every assertion is backed by a nearby invariant or unavoidable foreign API.
- Optional properties describe real absence, not unrelated states.
- Indexed access and nullable values are safe under the effective strict flags.
- Domain identifiers cannot be mixed accidentally where the cost would matter.
- Public exports and module side effects are intentional.
- Rejected input and error identity are tested.
