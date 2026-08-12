---
name: typescript-idioms
description: Everyday TypeScript idioms—illegal states, Zod validation, const assertions, exhaustive switches. Use for routine .ts/.tsx/.js work when not optimizing tsc, designing advanced types, or doing React/Next reviews.
---

# TypeScript Idioms

Language idioms for day-to-day TypeScript. Prefer this guide first for ordinary implementation work.

For React review → `modules/typescript-react-reviewer/GUIDE.md`.  
For Next.js App Router → `modules/nextjs-react-typescript/GUIDE.md`.  
For compiler performance → `modules/typescript/GUIDE.md`.

## Make illegal states unrepresentable

**Discriminated unions for mutually exclusive states:**

```ts
// Good: only valid combinations possible
type RequestState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: Error };

// Bad: allows { loading: true, error: Error }
type RequestStateBad<T> = {
  loading: boolean;
  data?: T;
  error?: Error;
};
```

**Branded types for domain primitives:**

```ts
type UserId = string & { readonly __brand: "UserId" };
type OrderId = string & { readonly __brand: "OrderId" };

function getUser(id: UserId): Promise<User> {
  /* ... */
}
```

For deeper branding / type-guard patterns → `modules/typescript-pro/GUIDE.md`.

**Const assertions for literal unions:**

```ts
const ROLES = ["admin", "user", "guest"] as const;
type Role = (typeof ROLES)[number];

function isValidRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}
```

**Exhaustive switch with `never`:**

```ts
type Status = "active" | "inactive";

function processStatus(status: Status): string {
  switch (status) {
    case "active":
      return "processing";
    case "inactive":
      return "skipped";
    default: {
      const _exhaustive: never = status;
      throw new Error(`unhandled status: ${_exhaustive}`);
    }
  }
}
```

## Runtime validation with Zod

- Schemas as single source of truth; types via `z.infer<>`.
- `safeParse` for expected user-input failure; `parse` at trust boundaries.
- Compose with `.extend()`, `.pick()`, `.omit()`, `.merge()`.
- Normalize with `.transform()` at parse time.

```ts
import { z } from "zod";

const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1),
  createdAt: z.string().transform((s) => new Date(s)),
});

type User = z.infer<typeof UserSchema>;

export async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  if (!response.ok) {
    throw new Error(`fetch user ${id} failed: ${response.status}`);
  }
  return UserSchema.parse(await response.json());
}

const result = UserSchema.safeParse(formData);
if (!result.success) {
  setErrors(result.error.flatten().fieldErrors);
  return;
}
```

## Optional: type-fest

When builtins are insufficient, prefer [type-fest](https://github.com/sindresorhus/type-fest):

- `Opaque<T, Token>` — branded types
- `PartialDeep<T>` / `ReadonlyDeep<T>` — recursive modifiers
- `SetRequired<T, K>` / `SetOptional<T, K>` — targeted field changes
- `Simplify<T>` — flatten intersections for IDE readability

```ts
import type { Opaque, PartialDeep } from "type-fest";

type UserId = Opaque<string, "UserId">;
type UserPatch = PartialDeep<User>;
```
